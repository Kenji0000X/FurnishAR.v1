'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  browserContext, browserHandoff, assessCapabilities, classifyRefusal, sessionInit,
  minimalSessionInit, diagnosticReport, DIAG, DIAG_COPY, MEASURE_METHOD, METHOD_LABEL,
  LEVEL, LEVEL_LABEL
} from '../../lib/spatial/capabilities.mjs';
import { HeadingTracker } from '../../lib/spatial/heading.mjs';
import { cameraPose } from '../../lib/spatial/orientation.mjs';
import { AI_VISION, AI_VISION_LABEL } from '../../lib/spatial/ai/config.mjs';
import { AI_ERROR_COPY } from '../../lib/spatial/ai/benchmark.mjs';
import { sampleScene } from '../../lib/spatial/ai/camera-scene.mjs';

/*
   A device health check, not a verdict.

   Every row is something this page OBSERVED on this phone, in this browser,
   just now: a session that opened (or was refused, and what the refusal
   said), frames that returned a surface, orientation events that arrived and
   how fast. What that probably means is written separately, as probable,
   and what to do about it separately again. The old page turned "the browser
   refused a session" into "Google Play Services for AR is missing", which is
   one possible cause stated as fact.

   The AR check makes ONE request from the tap, the same minimal request the
   planner makes (hit-test required; local-floor, dom-overlay, plane-detection
   optional; depth never). The old page walked five configurations from one
   tap; only the first ran with the tap's user activation, so the rest could
   fail for that reason alone and were then reported as missing features.
   A different configuration is tried only from a second, separate tap.

   Nothing here leaves the phone except what the person copies themselves,
   and the copyable report is an allowlist with no hardware identifiers.

   The page answers one question first: CAN THIS PHONE USE FURNISHAR, and
   how? That answer is recommendExperience() in capabilities.mjs, levels A–E,
   decided from what was observed here — never a percentage. The optional AI
   check measures a real inference on this phone (lib/spatial/ai/runtime.mjs,
   downloaded only after its button is tapped) and can only ADD to the
   answer: it never makes tracked AR "work", and a failed or skipped AI check
   takes nothing away.
*/

const STATUS = {
  yes: { label: 'Available', tone: 'ok' },
  limited: { label: 'Available with limitations', tone: 'warn' },
  no: { label: 'Unavailable', tone: 'bad' },
  warn: { label: 'Needs attention', tone: 'warn' },
  idle: { label: 'Not tested', tone: 'idle' },
  na: { label: 'Not required', tone: 'idle' }
};

function HealthRow({ label, status, detail }) {
  const s = STATUS[status] || STATUS.idle;
  return (
    <div className={`diag-row is-${s.tone}`}>
      <span className="diag-q">{label}</span>
      <span className="diag-a">
        <b>{s.label}</b>
        {detail ? <small>{detail}</small> : null}
      </span>
    </div>
  );
}

export default function Diagnostics() {
  const [facts, setFacts] = useState(null);
  const [busy, setBusy] = useState(null);          // 'ar' | 'sensors' | 'ai' | null
  const [aiProgress, setAiProgress] = useState('');
  const [copied, setCopied] = useState('');
  const overlayRef = useRef(null);
  const merge = patch => setFacts(current => ({ ...current, ...patch }));

  /* What can be known without asking for the camera. */
  useEffect(() => {
    const ctx = browserContext(navigator.userAgent, { maxTouchPoints: navigator.maxTouchPoints, platform: navigator.platform });
    const base = {
      generatedAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      ...ctx,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      devicePixelRatio: window.devicePixelRatio,
      secureContext: window.isSecureContext,
      webxr: 'xr' in navigator,
      cameraApi: typeof navigator.mediaDevices?.getUserMedia === 'function',
      webgl: (() => {
        try {
          const c = document.createElement('canvas');
          return Boolean(c.getContext('webgl2') || c.getContext('webgl'));
        } catch { return false; }
      })()
    };
    if (!base.webxr || ctx.inAppBrowser || ctx.platform === 'ios') { setFacts({ ...base, immersiveArAdvertised: base.webxr ? undefined : false }); return; }
    navigator.xr.isSessionSupported('immersive-ar')
      .then(ok => setFacts({ ...base, immersiveArAdvertised: ok }))
      .catch(() => setFacts({ ...base, immersiveArAdvertised: false }));
  }, []);

  const assessment = useMemo(() => (facts ? assessCapabilities(facts) : null), [facts]);

  /* ---------------------------------------------------------- AR check -- */
  async function runAR(minimal = false) {
    setBusy('ar');
    const out = { sessionStarted: false, sessionError: undefined, hitTestVerified: undefined, sessionFeatures: [], frames: 0, hitFrames: 0, planesObserved: 0, depthObserved: false, sessionConfig: minimal ? 'minimal' : 'standard' };
    let session = null;
    try {
      session = await navigator.xr.requestSession('immersive-ar', minimal
        ? minimalSessionInit()
        : sessionInit({ domOverlayRoot: overlayRef.current || document.body, purpose: 'scan' }));
    } catch (error) {
      out.sessionError = { ...classifyRefusal(error, facts), name: error?.name || 'Error', message: error?.message || '' };
      merge(out);
      setBusy(null);
      return;
    }

    try {
      out.sessionStarted = true;
      out.sessionFeatures = [...(session.enabledFeatures || [])];
      out.localFloorAvailable = out.sessionFeatures.includes('local-floor');
      out.planeDetectionAvailable = out.sessionFeatures.includes('plane-detection');

      /* A session does not schedule frames until it has a base layer. */
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2', { xrCompatible: true, alpha: true })
        || canvas.getContext('webgl', { xrCompatible: true, alpha: true });
      if (!gl) throw new Error('No WebGL context for the AR session');
      await gl.makeXRCompatible();
      session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl) });

      let refSpace = null;
      for (const kind of ['local-floor', 'local', 'viewer']) {
        try { refSpace = await session.requestReferenceSpace(kind); break; } catch { /* next */ }
      }
      if (!refSpace) throw new Error('No reference space');
      const viewer = await session.requestReferenceSpace('viewer');

      let source = null;
      try {
        source = await session.requestHitTestSource({ space: viewer });
        out.hitTestVerified = Boolean(source);
      } catch (err) {
        out.hitTestVerified = false;
        out.hitTestError = `${err?.name}: ${err?.message}`;
      }

      await new Promise(resolve => {
        const started = performance.now();
        let lostFrames = 0;
        const onFrame = (_time, frame) => {
          out.frames += 1;
          const pose = frame.getViewerPose(refSpace);
          if (!pose) lostFrames += 1;
          if (source) {
            try { if (frame.getHitTestResults(source).length > 0) out.hitFrames += 1; } catch { /* no pose */ }
          }
          if (frame.detectedPlanes) out.planesObserved = Math.max(out.planesObserved, frame.detectedPlanes.size);
          for (const view of pose?.views || []) {
            try { if (frame.getDepthInformation?.(view)) out.depthObserved = true; } catch { /* not granted */ }
          }
          if (performance.now() - started > 6000) {
            out.trackedFrameRatio = out.frames ? Math.round((1 - lostFrames / out.frames) * 100) / 100 : 0;
            out.trackingQuality = out.frames ? `${Math.round(out.trackedFrameRatio * 100)}% of frames tracked` : 'no frames';
            return resolve();
          }
          session.requestAnimationFrame(onFrame);
        };
        session.requestAnimationFrame(onFrame);
        setTimeout(resolve, 10000);
      });
    } catch (err) {
      out.sessionError = { state: DIAG.AR_RUNTIME_PROBLEM, name: err?.name || 'Error', message: err?.message || String(err) };
    } finally {
      try { await session?.end(); } catch { /* already ended */ }
      out.measurementMethod = 'webxr-hit-test';
      merge(out);
      setBusy(null);
    }
  }

  /* ------------------------------------------------- camera and sensors -- */
  async function runSensors() {
    setBusy('sensors');
    const out = { cameraOpened: false, orientationEvents: 0, motionEvents: 0, absoluteHeadingAvailable: false };

    try {
      const gate = window.DeviceOrientationEvent?.requestPermission;
      if (typeof gate === 'function' && (await gate.call(window.DeviceOrientationEvent)) !== 'granted') out.motionDenied = true;
    } catch { /* Android has no gate */ }

    /* Four seconds of real readings. The heading is judged by the same
       glitch rejector the measurer uses, on the line of sight's bearing.
       The camera opens inside the same window, so the scene check knows
       where the camera is pointing (is the floor in view?). */
    const tracker = new HeadingTracker();
    let angleFromDown = null;
    const onOrient = e => {
      if (!Number.isFinite(e.beta)) return;
      out.orientationEvents += 1;
      if (e.absolute || Number.isFinite(e.webkitCompassHeading)) out.absoluteHeadingAvailable = true;
      const pose = cameraPose({ alpha: e.alpha, beta: e.beta, gamma: e.gamma }, window.screen?.orientation?.angle || 0);
      if (Number.isFinite(pose?.angleFromDown)) angleFromDown = pose.angleFromDown;
      tracker.push(Number.isFinite(pose?.heading) ? pose.heading : null, performance.now());
    };
    const onMotion = e => { if (e.accelerationIncludingGravity?.x != null) out.motionEvents += 1; };
    window.addEventListener('deviceorientation', onOrient);
    window.addEventListener('devicemotion', onMotion);
    const started = performance.now();

    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      const settings = stream.getVideoTracks()[0]?.getSettings?.() || {};
      out.cameraOpened = true;
      out.cameraResolution = settings.width && settings.height ? `${settings.width}x${settings.height}` : 'unknown';
      /* Scene quality: a few frames judged on the phone (light, blur,
         detail, motion). The frames are never kept or sent. */
      const scene = await sampleScene(stream, { angleFromDown: () => angleFromDown });
      if (scene) {
        Object.assign(out, {
          sceneAnalysisAvailable: true,
          lightingQuality: scene.lightingQuality,
          motionBlur: scene.motionBlur,
          sceneTextureQuality: scene.sceneTextureQuality,
          cameraMotion: scene.cameraMotion,
          floorConfidence: scene.floorConfidence,
          wallConfidence: scene.wallConfidence,
          sceneGuidance: scene.guidance
        });
      }
    } catch (err) {
      out.cameraOpened = false;
      out.cameraDenied = err?.name === 'NotAllowedError';
      out.cameraError = err?.name || 'Error';
    } finally {
      for (const track of stream?.getTracks() || []) track.stop();
    }

    await new Promise(resolve => setTimeout(resolve, Math.max(0, 4000 - (performance.now() - started))));
    window.removeEventListener('deviceorientation', onOrient);
    window.removeEventListener('devicemotion', onMotion);
    out.orientationRate = Math.round((out.orientationEvents / ((performance.now() - started) / 1000)) * 10) / 10;
    out.headingVerdict = tracker.reliability.verdict;
    out.headingRejected = Math.round(tracker.reliability.rejectedFraction * 100);
    merge(out);
    setBusy(null);
  }

  /* ----------------------------------------------------------- AI check -- */
  /* Optional. The runtime and the test model download only now, after this
     tap (never while browsing), run on this phone, and are released at the
     end. A failure is recorded as a level ("Unavailable") and a reason; it
     never disables anything else on the page. */
  async function runAI() {
    setBusy('ai');
    setAiProgress('Starting…');
    try {
      const { checkAiCapability } = await import('../../lib/spatial/ai/runtime.mjs');
      merge(await checkAiCapability({ onProgress: setAiProgress }));
    } catch (error) {
      merge({ aiMode: AI_VISION.NONE, aiRuntimeAvailable: false, aiError: { code: 'ai-unavailable', name: error?.name || 'Error', message: String(error?.message || '').slice(0, 200) } });
    } finally {
      setAiProgress('');
      setBusy(null);
    }
  }

  async function copyReport() {
    const text = JSON.stringify(diagnosticReport(facts, assessment), null, 2);
    try {
      await navigator.clipboard.writeText(text);
      setCopied('Copied. Paste it wherever the report is needed.');
    } catch {
      setCopied('Copying is blocked here. Select the text below and copy it.');
    }
  }

  if (!facts || !assessment) return <p className="diagnose-intro">Asking the browser…</p>;

  const embedded = Boolean(facts.inAppBrowser);
  const handoff = embedded ? browserHandoff(facts, window.location.href) : null;
  const ios = facts.platform === 'ios';
  const copy = DIAG_COPY[assessment.state] || DIAG_COPY[DIAG.AR_ADVERTISED_NOT_VERIFIED];
  const arChecked = facts.sessionStarted !== undefined || facts.sessionError;
  const sensorsChecked = facts.cameraOpened !== undefined;

  /* ------------------------------------------------------------- rows -- */
  /* A refused session is not proof the phone cannot do it, so it "needs
     attention"; "unavailable" is kept for a browser that does not offer AR. */
  const tracked = assessment.trackedVerified ? 'yes'
    : [DIAG.TRACKING_AVAILABLE_NO_SURFACE, DIAG.AR_ADVERTISED_NOT_VERIFIED].includes(assessment.trackedState) ? (arChecked ? 'warn' : 'idle')
      : [DIAG.AR_SESSION_REFUSED, DIAG.AR_RUNTIME_PROBLEM, DIAG.HIT_TEST_UNAVAILABLE, DIAG.CAMERA_PERMISSION_DENIED].includes(assessment.trackedState) ? 'warn'
        : 'no';
  const hitTest = facts.hitTestVerified === true ? 'yes' : facts.hitTestVerified === false ? 'no' : 'idle';
  const floor = !arChecked || !facts.sessionStarted ? 'idle' : facts.hitFrames > 0 ? 'yes' : 'warn';
  const camera = !sensorsChecked ? 'idle' : facts.cameraOpened ? 'yes' : 'no';
  const motion = !sensorsChecked ? 'idle' : facts.orientationEvents > 0 ? (facts.orientationRate >= 8 ? 'yes' : 'warn') : 'no';
  const headingStatus = !sensorsChecked || !facts.orientationEvents ? 'idle'
    : facts.headingVerdict === 'good' ? 'yes' : facts.headingVerdict === 'unknown' ? 'idle' : 'warn';

  const depthStatus = !arChecked || !facts.sessionStarted ? 'na' : facts.depthObserved ? 'yes' : 'na';
  const aiTested = facts.aiMode !== undefined;
  const aiStatus = !aiTested ? 'idle'
    : facts.aiMode === AI_VISION.GPU || facts.aiMode === AI_VISION.REALTIME ? 'yes'
      : facts.aiMode === AI_VISION.SINGLE_FRAME ? 'limited' : 'no';
  const aiDetail = !aiTested ? 'Optional. Tap “Check AI camera capability” below.'
    : facts.aiRuntimeAvailable
      ? `${AI_VISION_LABEL[facts.aiMode] || 'Unavailable'} · ${facts.aiBackend === 'webgpu' ? 'GPU (WebGPU)' : 'CPU (WebAssembly)'} · ${facts.aiAverageInferenceMs} ms average, ${facts.aiP95InferenceMs} ms at worst (p95).`
      : AI_ERROR_COPY[facts.aiError?.code] || AI_ERROR_COPY['ai-unavailable'];
  const sceneChecked = facts.sceneAnalysisAvailable === true && facts.lightingQuality;
  const sceneStatus = !sensorsChecked ? 'idle' : !sceneChecked ? (facts.cameraOpened ? 'idle' : 'no')
    : (facts.sceneGuidance || []).length ? 'warn' : 'yes';
  const sceneDetail = !sceneChecked ? (sensorsChecked && facts.cameraOpened ? 'The camera frames could not be read here.' : null)
    : (facts.sceneGuidance || []).length ? facts.sceneGuidance.join(' ')
      : 'Good light, sharp, enough detail to track.';

  const rec = assessment.recommendation;
  const fallbackLabel = rec.fallback ? LEVEL_LABEL[rec.fallback] : null;

  return (
    <>
      {embedded && (
        <div className="diag-callout" role="alert">
          <b>{DIAG_COPY[DIAG.IN_APP_BROWSER].title}</b>
          <p>You are in {facts.inAppName}&apos;s built-in browser. It does not provide the camera tracking FurnishAR uses. That says nothing about your phone.</p>
          <div className="diag-actions">
            {handoff && <a className="button button-primary" href={handoff.href}>{handoff.label}</a>}
          </div>
          <p className="diag-small">
            {ios ? 'Or tap ··· or the share icon, then Open in Safari.' : 'Or tap ⋮ and choose Open in Chrome (or Open in browser).'}
          </p>
        </div>
      )}

      <section className="diag-summary" aria-labelledby="diag-summary-title">
        <p className="eyebrow">Device check</p>
        <p className="diag-recommend diag-recommend-top">
          <span>Recommended FurnishAR mode</span>
          <b id="diag-summary-title">{LEVEL_LABEL[rec.level]}</b>
          <small className={`status-chip ${rec.confirmed ? 'is-success' : 'is-warning'}`}>
            {rec.level === LEVEL.OPEN_EXTERNAL_BROWSER || rec.level === LEVEL.OPEN_SECURE_ADDRESS ? 'Do this first'
              : rec.confirmed ? 'Best available on this phone' : 'To be confirmed'}
          </small>
        </p>
        <p className="diag-reason">{rec.reason}</p>
        {fallbackLabel && <p className="diag-fallback"><b>Fallback.</b> {fallbackLabel}</p>}
        <h2 className="diag-state">{copy.title}</h2>
        <p><b>Observed.</b> {copy.observed}</p>
        {copy.likely && <p><b>Likely cause.</b> {copy.likely}</p>}
        {facts.sessionError?.likelyCauses && !copy.likely && (
          <p><b>Possible causes.</b> {facts.sessionError.likelyCauses.join('; ')}. Which one is not known from this alone.</p>
        )}
        {copy.action && <p><b>What to do.</b> {copy.action}</p>}
      </section>

      <div className="diag-list" role="list">
        <HealthRow label="Tracked AR" status={ios ? 'no' : tracked}
          detail={ios ? 'iPhone uses Apple AR Quick Look for furniture.' : embedded ? 'Not available in an in-app browser.' : facts.sessionError ? `Session refused (${facts.sessionError.name}).` : facts.sessionStarted ? `Session opened: ${facts.sessionFeatures.join(', ') || 'no optional features'}.` : facts.immersiveArAdvertised ? 'Offered by this browser; not yet confirmed.' : 'Not offered by this browser.'} />
        <HealthRow label="Hit testing" status={hitTest}
          detail={hitTest === 'yes' ? 'The session provides hit-testing.' : hitTest === 'no' ? 'The session opened without hit-testing.' : null} />
        <HealthRow label="Floor tracking" status={floor}
          detail={floor === 'yes' ? `A surface was found in ${facts.hitFrames} of ${facts.frames} frames.` : floor === 'warn' ? 'No surface found in six seconds. Try better light and a patterned floor.' : null} />
        <HealthRow label="Camera" status={camera}
          detail={facts.cameraOpened ? `Rear camera opened at ${facts.cameraResolution}.` : facts.cameraDenied ? 'Camera access was refused for this site.' : sensorsChecked ? 'The camera would not open.' : null} />
        <HealthRow label="Motion sensor" status={motion}
          detail={sensorsChecked ? (facts.orientationEvents ? `${facts.orientationEvents} readings, about ${facts.orientationRate} per second.` : facts.motionDenied ? 'Motion access was refused.' : 'No readings.') : null} />
        <HealthRow label="Heading quality" status={headingStatus}
          detail={headingStatus === 'yes' ? 'Steady. A room outline can be built by turning.' : headingStatus === 'warn' ? `Unsteady (${facts.headingRejected}% of readings rejected). Single distances work; use photo or tape for the room.` : null} />
        <HealthRow label="Depth" status={depthStatus}
          detail={facts.depthObserved ? 'The session also provided depth. It is an extra, never needed.' : 'Placing and measuring never need depth.'} />
        <HealthRow label="Scene" status={sceneStatus} detail={sceneDetail} />
        <HealthRow label="AI vision" status={aiStatus} detail={aiDetail} />
      </div>

      {!embedded && !ios && facts.webxr && facts.secureContext && (
        <div className="diag-deep" ref={overlayRef}>
          <p className="diagnose-intro">
            The AR check opens the camera for about six seconds. Point at the floor
            and move slowly while it runs.
          </p>
          <div className="diag-actions">
            <button className="button button-primary" type="button" onClick={() => runAR(false)} disabled={Boolean(busy)}>
              {busy === 'ar' ? 'Running — point at the floor…' : arChecked ? 'Run the AR check again' : 'Run the AR check'}
            </button>
            {/* A different request only from a new tap. */}
            {facts.sessionError && facts.sessionConfig !== 'minimal' && (
              <button className="button" type="button" onClick={() => runAR(true)} disabled={Boolean(busy)}>
                Try a simpler AR session
              </button>
            )}
          </div>
        </div>
      )}

      <div className="diag-deep">
        <p className="diagnose-intro">
          The sensor check opens the camera briefly, looks at the light and detail in
          view, and reads the motion sensors for four seconds. Hold the phone up and
          turn slowly left and right.
        </p>
        <button className="button" type="button" onClick={runSensors} disabled={Boolean(busy)}>
          {busy === 'sensors' ? 'Checking — turn slowly…' : 'Check the camera and motion sensors'}
        </button>
      </div>

      <div className="diag-deep">
        <p className="diagnose-intro">
          Optional: time an AI camera model on this phone. It downloads about 8–11 MB
          once (the runtime and a test model), runs entirely on the phone, and sends
          nothing anywhere. FurnishAR works without it.
        </p>
        <button className="button" type="button" onClick={runAI} disabled={Boolean(busy)} aria-busy={busy === 'ai' || undefined}>
          {busy === 'ai' ? (aiProgress || 'Checking…') : aiTested ? 'Check AI camera capability again' : 'Check AI camera capability'}
        </button>
      </div>

      {assessment.measurementMethods.length > 0 && (
        <div className="diag-methods">
          <h3>Ways to measure a room on this phone</h3>
          <ul>
            {assessment.measurementMethods.map(m => (
              <li key={m}>{METHOD_LABEL[m]}{m === MEASURE_METHOD.MANUAL ? ' — most accurate' : m === MEASURE_METHOD.TRACKED_SCAN && !assessment.trackedVerified ? ' — to be confirmed' : ''}</li>
            ))}
          </ul>
          {assessment.reasons.map(r => <p key={r} className="diag-small">{r}</p>)}
        </div>
      )}

      <details className="diag-ua">
        <summary>Technical details</summary>
        <p className="diag-small">
          No hardware identifiers (IMEI, serial number, SIM or network addresses) are read or shown.
          Nothing is sent anywhere; the report is only copied if you copy it.
        </p>
        <button className="button button-outline" type="button" onClick={copyReport}>Copy technical report</button>
        {copied && <p className="diag-small" role="status">{copied}</p>}
        <pre className="diag-report">{JSON.stringify(diagnosticReport(facts, assessment), null, 2)}</pre>
      </details>
    </>
  );
}

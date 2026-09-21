'use client';

import { useEffect, useRef, useState } from 'react';

/*
   Every question this asks is one the room scanner's behaviour depends on,
   and each is asked the same way the engine asks it — navigator.xr,
   isSessionSupported, and, for the features that can only be known by trying,
   an actual requestSession. Reporting "supported" from a feature LIST rather
   than from a granted session is how the plane-detection problem hid for so
   long: the engine asked for it optionally, the browser accepted the request
   and then simply never produced a plane.

   So the deep checks open a real session. That needs a user gesture, which is
   why it is behind a button rather than running on load.
*/

const VERDICTS = {
  yes: { label: 'Yes', tone: 'ok' },
  no: { label: 'No', tone: 'bad' },
  unknown: { label: 'Not checked yet', tone: 'idle' }
};

function Row({ question, verdict, detail }) {
  const v = VERDICTS[verdict] || VERDICTS.unknown;
  return (
    <div className={`diag-row is-${v.tone}`}>
      <span className="diag-q">{question}</span>
      <span className="diag-a">
        <b>{v.label}</b>
        {detail ? <small>{detail}</small> : null}
      </span>
    </div>
  );
}

export default function Diagnostics() {
  const [basic, setBasic] = useState(null);
  const [deep, setDeep] = useState(null);
  const [busy, setBusy] = useState(false);
  const [fallback, setFallback] = useState(null);
  const [fallbackBusy, setFallbackBusy] = useState(false);
  /* The element handed to the session as its DOM overlay root. The engine
     passes one; a check that asks for 'dom-overlay' without it is asking a
     different question than the scanner asks. */
  const overlayRef = useRef(null);

  // The questions that can be answered without asking for the camera.
  useEffect(() => {
    const hasXR = typeof navigator !== 'undefined' && 'xr' in navigator;
    const result = {
      userAgent: navigator.userAgent,
      secure: window.isSecureContext,
      webxr: hasXR,
      immersiveAR: 'unknown',
      camera: typeof navigator.mediaDevices?.getUserMedia === 'function',
      webgl: (() => {
        try {
          const c = document.createElement('canvas');
          return Boolean(c.getContext('webgl2') || c.getContext('webgl'));
        } catch { return false; }
      })()
    };
    if (!hasXR) { setBasic(result); return; }
    navigator.xr.isSessionSupported('immersive-ar')
      .then(ok => setBasic({ ...result, immersiveAR: ok }))
      .catch(err => setBasic({ ...result, immersiveAR: false, arError: err?.message }));
  }, []);

  /*
     The deep check. Opens a real immersive-ar session and asks it what it
     actually granted, then — for plane detection — waits a few seconds of
     real frames to see whether any plane ever arrives. A browser can accept
     'plane-detection' as an optional feature and still never report a plane,
     which is exactly the case that broke the scanner, so "did you accept it"
     and "did you ever produce one" are asked separately.
  */
  async function runDeep() {
    setBusy(true);
    const out = {
      hitTest: 'no', planes: 'no', depth: 'no',
      planeCount: 0, planesApi: false,
      frames: 0, hits: 0,
      config: null, granted: [], error: null, tried: [], firstError: null
    };
    let session = null;

    /*
       Try the same ladder of configurations the scanner uses, and report
       WHICH rung this phone accepts.

       The first version of this asked once, with a depthSensing init dict,
       and a phone that could not satisfy that dict refused the whole request
       with "NotSupportedError: The specified session configuration is not
       supported". Because the throw skipped the line that sets hitTest to
       'yes', the page then reported "Hit-test: No" — a capability it had
       never actually tested. It told a user their phone could not measure
       when the truth was that this page had asked the wrong question.

       That is the same bug the scanner had, and finding it here is the only
       reason it was found there.
    */
    const root = overlayRef.current || document.body;
    const CONFIGS = [
      ['full (with depth config)', {
        requiredFeatures: ['hit-test'],
        optionalFeatures: ['local-floor', 'dom-overlay', 'plane-detection', 'depth-sensing'],
        depthSensing: {
          usagePreference: ['cpu-optimized'],
          dataFormatPreference: ['luminance-alpha', 'float32']
        },
        domOverlay: { root }
      }],
      ['no depth config', {
        requiredFeatures: ['hit-test'],
        optionalFeatures: ['local-floor', 'dom-overlay', 'plane-detection'],
        domOverlay: { root }
      }],
      ['hit-test + overlay', {
        requiredFeatures: ['hit-test'],
        optionalFeatures: ['local-floor', 'dom-overlay'],
        domOverlay: { root }
      }],
      ['bare hit-test', { requiredFeatures: ['hit-test'] }],
      ['nothing required', { optionalFeatures: ['hit-test', 'local-floor'] }]
    ];

    for (const [name, init] of CONFIGS) {
      try {
        session = await navigator.xr.requestSession('immersive-ar', init);
        out.config = name;
        break;
      } catch (err) {
        /* Keep the MESSAGE, not just the name. Every rung of the ladder
           reports NotSupportedError; only the message says which thing was
           not supported, and that is the line that tells someone what to
           actually do about it. Logging the name alone turned five different
           failures into five identical words. */
        out.tried.push(`${name} — ${err?.name}: ${err?.message || '(no message)'}`);
        /* Only the FIRST attempt runs under the button's fresh user
           activation. Chrome may refuse the later ones because the gesture
           has been spent rather than because the feature is missing, so the
           first refusal is the one worth diagnosing from. */
        if (!out.firstError) out.firstError = { name: err?.name || 'Error', message: err?.message || '' };
      }
    }

    if (!session) {
      out.error = `Every configuration refused. ${out.tried.join('; ')}`;
      setDeep(out);
      setBusy(false);
      return;
    }

    try {
      out.granted = [...(session.enabledFeatures || [])];

      /*
         The part that was missing, and the reason every earlier run of this
         page reported "Plane detection: No" and "Depth sensor: No" on phones
         that have both.

         An XRSession does not reliably schedule an animation frame until its
         render state has a base layer. Without one, session.requestAnimationFrame
         registers a callback that may never be called — so the six-second
         loop below either never ran (leaving the button stuck on "Running…")
         or ran too little to see anything, and the rows it fills kept their
         initial value of 'no'. Either way the page was not measuring those
         features; it was printing a default and calling it an answer.

         scripts/check-diagnose.mjs holds that behaviour still: against a fake
         device that reports a surface and three planes on every frame, this
         page before the fix ran zero frames.

         The scanner sets a base layer (ar-engine.js, startNativeAR) which is
         why AR runs there and not here. Same three lines, same order.
      */
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2', { xrCompatible: true, alpha: true })
        || canvas.getContext('webgl', { xrCompatible: true, alpha: true });
      if (!gl) throw new Error('No WebGL context for the AR session');
      await gl.makeXRCompatible();
      session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl) });

      /* 'local' is what the engine asks for, but a session granted under the
         bottom rungs of the ladder may only offer 'viewer'. Falling back is
         better than throwing: a viewer-space run still counts frames and hits. */
      let refSpace = null;
      for (const kind of ['local', 'local-floor', 'viewer']) {
        try { refSpace = await session.requestReferenceSpace(kind); break; } catch { /* next */ }
      }
      if (!refSpace) throw new Error('No reference space — the session cannot be tracked');
      const viewer = await session.requestReferenceSpace('viewer');

      // Hit-test is only "yes" once a SOURCE actually comes back, not merely
      // because the feature was named in the request.
      let source = null;
      try {
        source = await session.requestHitTestSource({ space: viewer });
        if (source) out.hitTest = 'yes';
      } catch (err) {
        out.error = `hit-test source: ${err?.name}: ${err?.message}`;
      }

      await new Promise(resolve => {
        const started = performance.now();
        const onFrame = (time, frame) => {
          out.frames += 1;

          /*
             A source is not a measurement. Getting one back proves the
             browser understands hit-testing; it proves nothing about whether
             ARCore on THIS phone, in THIS room, can find a surface to tap.
             That is the capability the room scanner is built on, so count the
             frames that actually returned a hit.
          */
          if (source) {
            try {
              if (frame.getHitTestResults(source).length > 0) out.hits += 1;
            } catch { /* no pose this frame */ }
          }

          const planes = frame.detectedPlanes;
          if (planes) {
            out.planesApi = true;
            out.planeCount = Math.max(out.planeCount, planes.size);
          }
          for (const view of frame.getViewerPose(refSpace)?.views || []) {
            try {
              if (frame.getDepthInformation?.(view)) out.depth = 'yes';
            } catch { /* not available on this view */ }
          }
          if (performance.now() - started > 6000) return resolve();
          session.requestAnimationFrame(onFrame);
        };
        session.requestAnimationFrame(onFrame);
        // If frames never arrive the promise above would hang forever and the
        // button would stay stuck on "Running…". Give up after ten seconds and
        // report frames: 0, which is itself the finding.
        setTimeout(resolve, 10000);
      });

      out.planes = out.planeCount > 0 ? 'yes' : 'no';
    } catch (err) {
      out.error = `${err?.name || 'Error'}: ${err?.message || err}`;
    } finally {
      try { await session?.end(); } catch { /* already gone */ }
      setDeep(out);
      setBusy(false);
    }
  }

  /*
     What is left when ARCore is not an option.

     A phone that is not on ARCore's supported device list will never run
     WebXR AR, and a native Android app would not change that — it would sit
     on the same ARCore. So the honest question becomes: what CAN this phone
     do? Two answers, both real measurement rather than AR theatre:

       1. Tilt-and-tap trigonometry. Stand still, hold the phone at a height
          you have told it, aim at the point where a wall meets the floor.
          The tilt angle and the height give the distance by
          distance = height x tan(angle from vertical). This is the same
          trigonometry a surveyor's clinometer uses. It needs
          DeviceOrientationEvent to actually FIRE with real numbers.

       2. Reference-object scaling. Photograph the wall with something of
          known size in shot — an A4 sheet is 297 x 210 mm, a bank card is
          85.6 x 54 mm — and scale the picture from it. This needs only a
          camera, so it is the floor: if this fails, nothing automatic works.

     Both are tested the way the AR check is now tested: by running them and
     counting what came back. 'ondeviceorientation' in window is true on
     plenty of phones whose sensors then report nothing, which is the same
     shape of lie as a feature list that promises planes and never sends one.
  */
  async function runFallback() {
    setFallbackBusy(true);
    const out = {
      camera: 'no', cameraDetail: '', resolution: null,
      orientation: 'no', orientationEvents: 0, tiltRange: null, absolute: false,
      motion: 'no', motionEvents: 0,
      error: null
    };

    // 1. The camera, actually opened — not merely present as an API.
    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } }, audio: false
      });
      const track = stream.getVideoTracks()[0];
      const s = track?.getSettings?.() || {};
      out.camera = 'yes';
      out.resolution = s.width && s.height ? `${s.width}x${s.height}` : 'unknown size';
      out.cameraDetail = `Rear camera opened at ${out.resolution}.`;
    } catch (err) {
      out.cameraDetail = `${err?.name}: ${err?.message}`;
    } finally {
      for (const track of stream?.getTracks() || []) track.stop();
    }

    /* 2. The tilt sensor. iOS 13+ gates this behind a permission call that
          must happen inside a user gesture; this whole function runs from
          the button's click, so the call is legal here. Android ignores it. */
    try {
      const gate = window.DeviceOrientationEvent?.requestPermission;
      if (typeof gate === 'function') {
        const granted = await gate.call(window.DeviceOrientationEvent);
        if (granted !== 'granted') out.error = 'Motion access was refused.';
      }
    } catch (err) {
      out.error = `Motion permission: ${err?.name}`;
    }

    await new Promise(resolve => {
      let min = Infinity, max = -Infinity;
      const onOrient = e => {
        // A phone with no sensor still fires the event with nulls. Count only
        // the readings that carry a real number.
        if (typeof e.beta !== 'number' || e.beta === null) return;
        out.orientationEvents += 1;
        if (e.absolute) out.absolute = true;
        min = Math.min(min, e.beta);
        max = Math.max(max, e.beta);
      };
      const onMotion = e => {
        if (e.accelerationIncludingGravity?.x == null) return;
        out.motionEvents += 1;
      };
      window.addEventListener('deviceorientation', onOrient);
      window.addEventListener('devicemotion', onMotion);
      setTimeout(() => {
        window.removeEventListener('deviceorientation', onOrient);
        window.removeEventListener('devicemotion', onMotion);
        out.orientation = out.orientationEvents > 0 ? 'yes' : 'no';
        out.motion = out.motionEvents > 0 ? 'yes' : 'no';
        if (out.orientationEvents > 0 && max > min) out.tiltRange = (max - min).toFixed(1);
        resolve();
      }, 3000);
    });

    setFallback(out);
    setFallbackBusy(false);
  }

  if (!basic) return <p className="diagnose-intro">Asking the browser…</p>;

  const arSupported = basic.immersiveAR === true;

  /*
     One sentence answering the only question anyone opens this page to ask:
     can this phone measure my room? The rows below it are the evidence.

     "Frames ran: 0" is called out on its own because it means the test did
     not happen. Reporting that as "your phone cannot do it" is the failure
     this page was guilty of until now, and it is worth never repeating.
  */
  /*
     Why every session was refused, and what the person holding the phone can
     do about it. Without this the page ends on "No" and a stack of identical
     NotSupportedErrors, which reads as "your phone is not good enough" — and
     in the most common case that is simply untrue.

     The signature worth naming: isSessionSupported said YES, then every
     configuration was refused, including the last rung, which requires no
     features at all. A phone whose hardware genuinely cannot do AR answers
     no to the first question. A phone that answers yes and then refuses
     everything is a phone whose AR runtime — Google Play Services for AR,
     a separate app from Chrome — is missing, out of date, or was declined
     when Chrome offered to install it. That is a two-minute fix, not a
     verdict on the device.
  */
  const refusal = deep && !deep.config && (() => {
    const msg = (deep.firstError?.message || '').toLowerCase();
    const name = deep.firstError?.name || '';
    if (name === 'NotAllowedError' || /permission|denied/.test(msg)) {
      return 'Camera access was refused. Tap the padlock next to the address bar, allow the camera, and run this again.';
    }
    if (name === 'SecurityError') {
      return 'The browser blocked the session for security reasons — usually a page that is not fully HTTPS, or a gesture it did not count as a tap.';
    }
    if (/install|arcore|play services/.test(msg)) {
      return 'Chrome says the AR runtime needs installing. Open the Play Store, install or update "Google Play Services for AR", then run this again.';
    }
    if (basic.immersiveAR === true) {
      return 'Chrome says this phone supports AR and then refuses every session, including one that asks for no features at all. That is what happens when "Google Play Services for AR" is missing or out of date — it is a separate app from Chrome and it does the actual tracking. Install or update it from the Play Store and run this check again.';
    }
    return 'This browser cannot open an AR session. On Android, use Chrome; on iPhone, Safari does not support WebXR at all.';
  })();

  const verdict = deep && (() => {
    if (!deep.config) return { tone: 'bad', text: `No — not yet. This phone would not start an AR session at all, so the scanner cannot run. ${refusal}` };
    if (deep.frames === 0) return { tone: 'idle', text: 'Unknown — the session opened but produced no frames, so nothing below was actually measured. Close other camera apps and try again.' };
    if (deep.hitTest !== 'yes') return { tone: 'bad', text: 'No. AR starts, but this phone offers no hit-testing, and tapping room corners depends on it.' };
    if (deep.hits === 0) return { tone: 'idle', text: 'Almost — hit-testing works, but no surface was found in six seconds. That is usually the room, not the phone: try again in better light, pointing at a patterned floor and moving slowly.' };
    return { tone: 'ok', text: 'Yes. This phone found real surfaces, so it can measure your room by tapping its corners.' };
  })();

  /*
     Deliberately ranked by honesty rather than by how impressive it sounds.
     Tilt measuring is good to roughly a few percent when the phone is held
     still at a height the person actually knows; the photo method is coarser
     but needs nothing but a lens; and typing in tape-measure numbers beats
     both on accuracy every time, so it is never presented as the booby prize.
  */
  const fallbackVerdict = fallback && (() => {
    if (fallback.orientation === 'yes' && fallback.camera === 'yes') {
      return { tone: 'ok', text: 'Yes. The camera and the tilt sensor both work, so this phone can measure a wall by aiming at the point where it meets the floor — no ARCore needed.' };
    }
    if (fallback.camera === 'yes') {
      return { tone: 'idle', text: 'Partly. The camera works but the tilt sensor reported nothing, so aim-and-measure is out. Photographing the wall beside something of known size — an A4 sheet, a bank card — still works, and typing in tape-measure figures is more accurate than either.' };
    }
    return { tone: 'bad', text: `No automatic method will work: the rear camera would not open. ${fallback.cameraDetail} Room sizes can still be typed in, and that is the most accurate method anyway.` };
  })();

  return (
    <>
      <div className="diag-list">
        <Row question="Page served securely (HTTPS)" verdict={basic.secure ? 'yes' : 'no'}
          detail={basic.secure ? null : 'AR and the camera need HTTPS.'} />
        <Row question="Browser has WebXR" verdict={basic.webxr ? 'yes' : 'no'}
          detail={basic.webxr ? null : 'No navigator.xr — this browser cannot do AR at all.'} />
        <Row question="Can open an AR session" verdict={
          basic.immersiveAR === 'unknown' ? 'unknown' : arSupported ? 'yes' : 'no'}
          detail={basic.arError || (arSupported ? null : 'immersive-ar not supported here.')} />
        <Row question="Camera API present" verdict={basic.camera ? 'yes' : 'no'} />
        <Row question="WebGL" verdict={basic.webgl ? 'yes' : 'no'} />
      </div>

      {arSupported && (
        <div className="diag-deep" ref={overlayRef}>
          <p className="diagnose-intro">
            The rest can only be answered by actually starting AR. This opens the
            camera for about six seconds, then closes it. Point the phone at the
            floor and move it slowly while it runs.
          </p>
          <button className="button button-primary" type="button" onClick={runDeep} disabled={busy}>
            {busy ? 'Running — point at the floor…' : 'Run the AR check'}
          </button>
        </div>
      )}

      {deep && (
        <>
          <p className={`diag-verdict is-${verdict.tone}`}>
            <b>Can this phone measure a room?</b> {verdict.text}
          </p>
          <div className="diag-list">
            <Row question="Session configuration accepted" verdict={deep.config ? 'yes' : 'no'}
              detail={deep.config
                ? `"${deep.config}"${deep.tried.length ? ` — refused first: ${deep.tried.join('; ')}` : ''}`
                : 'No configuration was accepted.'} />
            {/* Without this row, a zero-frame run is indistinguishable from a
                phone that genuinely lacks every feature. It is the first thing
                to read when the answers below look implausibly bleak. */}
            <Row question="AR frames actually ran" verdict={deep.frames > 0 ? 'yes' : 'no'}
              detail={deep.frames > 0
                ? `${deep.frames} frames in six seconds. Everything below was measured, not assumed.`
                : 'No frames arrived, so the results below mean nothing. This is a fault in the test, not a verdict on the phone.'} />
            <Row question="Hit-test (needed to tap corners)" verdict={deep.hitTest}
              detail={deep.hitTest === 'yes'
                ? 'The browser gave us a hit-test source.'
                : 'Without this, nothing can be measured.'} />
            {/* The one that decides it. A source is an API; a result is a real
                surface found by the camera in this room. */}
            <Row question="Found a real surface to tap" verdict={deep.hits > 0 ? 'yes' : 'no'}
              detail={deep.hits > 0
                ? `A surface was located in ${deep.hits} of ${deep.frames} frames. This is the capability the room scanner runs on.`
                : 'No surface was located. Try again with more light, on a floor with some pattern, moving the phone slowly.'} />
            <Row question="Plane detection (automatic walls and floor)" verdict={deep.planes}
              detail={deep.planes === 'yes'
                ? `Planes seen: ${deep.planeCount}. Automatic room detection is possible here.`
                : deep.planesApi
                  ? 'The feature was granted but no plane ever arrived — this is why the room is measured by tapping corners.'
                  : 'Not granted by this browser. Chrome on Android keeps it behind a flag, which is why the room is measured by tapping corners.'} />
            <Row question="Depth sensor" verdict={deep.depth}
              detail={deep.depth === 'yes' ? 'Occlusion can be accurate.' : 'Optional; the scanner works without it.'} />
            {deep.granted.length > 0 && (
              <Row question="Features the session granted" verdict="yes" detail={deep.granted.join(', ')} />
            )}
            {/* Above the raw error dump, because the dump is for me and this
                line is for the person who cannot scan their room. */}
            {refusal && <Row question="What to try next" verdict="unknown" detail={refusal} />}
            {deep.error && <Row question="Error while testing" verdict="no" detail={deep.error} />}
          </div>
        </>
      )}

      {/* Offered unprompted once AR has failed, and available to anyone else
          who wants to know. A page that ends at "your phone cannot do AR"
          leaves the person with nothing; these two methods need no ARCore. */}
      <div className="diag-deep">
        <h2 className="diag-subhead">If AR is not available</h2>
        <p className="diagnose-intro">
          A room can still be measured without ARCore — by aiming the phone at
          the foot of a wall and reading the tilt angle, or by photographing
          the wall next to something of known size. Both need real sensors,
          so this runs them and counts what comes back. About four seconds;
          hold the phone up and tilt it slowly while it runs.
        </p>
        <button className="button" type="button" onClick={runFallback} disabled={fallbackBusy}>
          {fallbackBusy ? 'Checking — tilt the phone…' : 'Check the camera and tilt sensor'}
        </button>
      </div>

      {fallback && (
        <>
          <p className={`diag-verdict is-${fallbackVerdict.tone}`}>
            <b>Can this phone measure without AR?</b> {fallbackVerdict.text}
          </p>
          <div className="diag-list">
            <Row question="Rear camera opens" verdict={fallback.camera}
              detail={fallback.cameraDetail} />
            <Row question="Tilt sensor reports angles" verdict={fallback.orientation}
              detail={fallback.orientationEvents > 0
                ? `${fallback.orientationEvents} readings in three seconds${fallback.tiltRange ? `, over a ${fallback.tiltRange}° range` : ''}. ${fallback.absolute ? 'Compass-referenced.' : 'Relative to where it started.'}`
                : 'No readings with a real angle in them. Aim-at-the-floor measuring is not possible here.'} />
            <Row question="Motion sensor responds" verdict={fallback.motion}
              detail={fallback.motionEvents > 0
                ? `${fallback.motionEvents} readings. Useful for telling the phone to hold still, not for measuring distance.`
                : 'No accelerometer readings.'} />
            {fallback.error && <Row question="Note" verdict="unknown" detail={fallback.error} />}
          </div>
        </>
      )}

      <details className="diag-ua">
        <summary>Device details (for the report)</summary>
        <p>{basic.userAgent}</p>
      </details>
    </>
  );
}

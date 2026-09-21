'use client';

import { useEffect, useState } from 'react';

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
    const out = { hitTest: 'no', planes: 'no', depth: 'no', planeCount: 0, error: null };
    let session = null;
    try {
      session = await navigator.xr.requestSession('immersive-ar', {
        requiredFeatures: ['hit-test'],
        optionalFeatures: ['local-floor', 'plane-detection', 'depth-sensing'],
        depthSensing: { usagePreference: ['cpu-optimized'], dataFormatPreference: ['luminance-alpha'] }
      });
      out.hitTest = 'yes';

      const refSpace = await session.requestReferenceSpace('local');
      const viewer = await session.requestReferenceSpace('viewer');
      try {
        await session.requestHitTestSource({ space: viewer });
      } catch {
        out.hitTest = 'no';
      }

      // Watch real frames for a few seconds. detectedPlanes existing at all is
      // the first bar; a plane actually arriving is the one that matters.
      await new Promise(resolve => {
        const started = performance.now();
        const onFrame = (time, frame) => {
          const planes = frame.detectedPlanes;
          if (planes) {
            out.planes = 'yes';
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
      });
    } catch (err) {
      out.error = `${err?.name || 'Error'}: ${err?.message || err}`;
    } finally {
      try { await session?.end(); } catch { /* already gone */ }
      setDeep(out);
      setBusy(false);
    }
  }

  if (!basic) return <p className="diagnose-intro">Asking the browser…</p>;

  const arSupported = basic.immersiveAR === true;

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
        <div className="diag-deep">
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
        <div className="diag-list">
          <Row question="Hit-test (needed to tap corners)" verdict={deep.hitTest}
            detail={deep.hitTest === 'yes'
              ? 'The room scanner can work on this phone.'
              : 'Without this, nothing can be measured.'} />
          <Row question="Plane detection (automatic walls and floor)" verdict={deep.planes}
            detail={deep.planes === 'yes'
              ? `Planes seen: ${deep.planeCount}. Automatic room detection is possible here.`
              : 'Not available — this is why the room is measured by tapping corners.'} />
          <Row question="Depth sensor" verdict={deep.depth}
            detail={deep.depth === 'yes' ? 'Occlusion can be accurate.' : 'Optional; the scanner works without it.'} />
          {deep.error && <Row question="Error while testing" verdict="no" detail={deep.error} />}
        </div>
      )}

      <details className="diag-ua">
        <summary>Device details (for the report)</summary>
        <p>{basic.userAgent}</p>
      </details>
    </>
  );
}

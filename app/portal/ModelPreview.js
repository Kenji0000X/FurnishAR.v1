'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowCounterClockwise, Check, Minus, WarningCircle } from '@phosphor-icons/react/dist/ssr';
import { normalizeModel, measure } from '../../lib/spatial/model-transform.mjs';
import { SCALE_STATUS } from '../../lib/spatial/model-scale.mjs';
import { formatDimensions, formatLength } from '../../lib/spatial/units.mjs';
import { supabase, usingSupabase } from './backend.js';

/**
 * The store owner's model, at the size shoppers will see it.
 *
 * Two jobs, kept apart on purpose:
 *
 *   PHYSICAL TRANSFORM  lib/spatial/model-transform.mjs — the same function the
 *                       AR session calls — scales the model to the product's
 *                       dimensions with ONE factor and stands it on the floor.
 *                       Nothing here changes that transform.
 *   CAMERA FRAMING      the camera moves back until the piece fits the canvas.
 *                       A 2 m sofa and a 30 cm stool are both fully in view,
 *                       and both are still their real size in the scene.
 *
 * (Before, the preview shrank every model to one unit across so it would fit
 * the canvas. Useful for looking, but it meant the preview could not show
 * the size the owner was about to publish.)
 *
 * A chosen file is previewed BEFORE it is uploaded, from a local object URL,
 * so a wrong model is caught before anyone waits for an upload. An uploaded
 * model is fetched the way the planner fetches it: a short-lived signed URL
 * for this signed-in account, never a public file.
 *
 * `onResult` reports what was verified, so the form can decide whether the
 * model may be saved. Every tick in the checklist below is something that was
 * measured, not assumed.
 */
export default function ModelPreview({
  source,            // { file } | { path } | null
  dimensionsCm,      // { width, depth, height } in cm, or null while incomplete
  unit = 'cm',       // how sizes are written; never how big anything is
  existing = false,  // an already-uploaded model rather than a newly chosen one
  onResult,
  onReviewDimensions,
  onReplaceModel,
  posterRef          // filled with { sourceKey, render() } once the model can be drawn
}) {
  const canvasRef = useRef(null);
  const sceneRef = useRef(null);   // { THREE, model, renderer, camera, controls, grid, frame() }
  const [phase, setPhase] = useState(source ? 'loading' : 'empty');
  const [failure, setFailure] = useState(null);
  const [result, setResult] = useState(null);
  const [drawable, setDrawable] = useState(true);
  const [drawn, setDrawn] = useState(false);   // the first frame is on screen

  const dimsKey = dimensionsKey(dimensionsCm);
  const sourceKey = modelSourceKey(source);
  // Read through refs, not closures: a large file can take seconds to parse,
  // and the size it is checked against is whatever the form says NOW, not
  // what it said when the file was chosen.
  const latest = useRef({});
  latest.current = { onResult, dimensionsCm, dimsKey, sourceKey };
  const report = useRef(null);
  report.current = outcome => latest.current.onResult?.({
    ...outcome,
    sourceKey: latest.current.sourceKey,
    dimsKey: latest.current.dimsKey
  });

  /* Load: file or stored path → parsed scene → measured. Rendering is set up
     here too, but validation does not depend on it: a phone that cannot draw
     WebGL still gets its model checked. */
  useEffect(() => {
    if (!sourceKey) {
      setPhase('empty');
      setResult(null);
      setFailure(null);
      report.current?.({ phase: 'empty' });
      return undefined;
    }
    let cancelled = false;
    let objectUrl = null;
    let teardown = null;
    setPhase('loading');
    setFailure(null);
    setResult(null);
    setDrawn(false);
    report.current?.({ phase: 'parsing' });

    (async () => {
      let THREE, GLTFLoader, MeshoptDecoder, DRACOLoader, OrbitControls;
      try {
        [THREE, { GLTFLoader }, { MeshoptDecoder }, { DRACOLoader }, { OrbitControls }] = await Promise.all([
          import('three'),
          import('three/examples/jsm/loaders/GLTFLoader.js'),
          import('three/examples/jsm/libs/meshopt_decoder.module.js'),
          import('three/examples/jsm/loaders/DRACOLoader.js'),
          import('three/examples/jsm/controls/OrbitControls.js')
        ]);
      } catch {
        if (!cancelled) fail('engine');
        return;
      }
      if (cancelled) return;

      let url;
      try {
        if (source.file) {
          objectUrl = URL.createObjectURL(source.file);
          url = objectUrl;
        } else {
          url = await resolvePath(source.path);
        }
      } catch {
        if (!cancelled) fail('access');
        return;
      }

      const loader = new GLTFLoader();
      loader.setMeshoptDecoder(MeshoptDecoder);
      loader.setDRACOLoader(new DRACOLoader().setDecoderPath('/draco/'));

      let gltf;
      try {
        gltf = await loader.loadAsync(url);
      } catch {
        if (!cancelled) fail('parse');
        return;
      } finally {
        // The object URL has done its job once the bytes are parsed.
        if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
      }
      if (cancelled) return;

      const model = gltf.scene;
      report.current?.({ phase: 'validating-geometry' });
      const { extent } = measure(THREE, model);
      if (!(extent.width > 0 && extent.depth > 0 && extent.height > 0)) {
        fail('empty-geometry');
        return;
      }

      const view = { THREE, model };
      sceneRef.current = view;
      try {
        view.renderer = new THREE.WebGLRenderer({ canvas: canvasRef.current, alpha: true, antialias: true });
      } catch {
        view.renderer = null;
      }
      setDrawable(Boolean(view.renderer));

      if (view.renderer) {
        const { renderer } = view;
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.1;
        const scene = new THREE.Scene();
        scene.add(new THREE.HemisphereLight(0xffffff, 0xc9c5bb, 2.0));
        const key = new THREE.DirectionalLight(0xfff6ec, 2.2);
        key.position.set(3, 5, 4);
        scene.add(key);
        scene.add(model);
        view.scene = scene;
        view.camera = new THREE.PerspectiveCamera(35, 1, 0.01, 200);
        view.controls = new OrbitControls(view.camera, canvasRef.current);
        view.controls.enablePan = false;

        // Drawn on demand, not every frame. A dense model can take tens of
        // milliseconds a frame on a laptop GPU; drawing it sixty times a
        // second while the owner is typing their price would make the whole
        // form feel slow for a picture that has not changed.
        let frame = 0;
        let running = true;
        view.render = () => {
          if (!running || frame) return;
          frame = requestAnimationFrame(() => {
            frame = 0;
            if (!running) return;
            renderer.render(scene, view.camera);
            if (!view.drawn) { view.drawn = true; setDrawn(true); }
          });
        };
        view.controls.addEventListener('change', view.render);

        const resize = () => {
          const rect = canvasRef.current?.getBoundingClientRect();
          if (!rect || !rect.width) return;
          renderer.setSize(rect.width, rect.height, false);
          view.camera.aspect = rect.width / Math.max(rect.height, 1);
          view.camera.updateProjectionMatrix();
          view.render();
        };
        const observer = new ResizeObserver(resize);
        observer.observe(canvasRef.current);
        resize();

        teardown = () => {
          running = false;
          if (frame) cancelAnimationFrame(frame);
          observer.disconnect();
          view.controls.dispose();
          scene.traverse(node => {
            node.geometry?.dispose?.();
            const materials = Array.isArray(node.material) ? node.material : [node.material];
            for (const material of materials) {
              if (!material) continue;
              for (const value of Object.values(material)) if (value?.isTexture) value.dispose();
              material.dispose();
            }
          });
          renderer.dispose();
        };
      }

      // Sizing happens in the effect below, once 'ready' has rendered, so it
      // always uses the current dimensions.
      setPhase('ready');
    })();

    function fail(kind) {
      setPhase('failed');
      setFailure(kind);
      report.current?.({ phase: 'error', errorKind: kind });
    }

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      teardown?.();
      sceneRef.current = null;
      if (posterRef) posterRef.current = null;
    };
    // sourceKey stands for `source`; the object itself is recreated on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey]);

  /* Re-size when the dimensions change — no reload, the geometry is kept. */
  useEffect(() => {
    if (phase === 'ready' && sceneRef.current) applySize(sceneRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dimsKey, phase]);

  function applySize(view) {
    const { THREE, model } = view;
    const { dimensionsCm } = latest.current;
    report.current?.({ phase: 'validating-scale' });
    if (!dimensionsCm) {
      // Nothing to size against yet: shown at its file size, and said so.
      model.scale.setScalar(1);
      model.position.set(0, 0, 0);
      const outcome = { status: SCALE_STATUS.NO_DIMENSIONS, verified: false, floorOk: false };
      setResult(outcome);
      frame(view);
      report.current?.({ phase: 'checked', ...outcome });
      return;
    }
    const { decision, verified, floorOffset } = normalizeModel(THREE, model, dimensionsCm);
    const outcome = {
      status: decision.status,
      decision,
      verified,
      floorOk: floorOffset !== null && Math.abs(floorOffset) < 1e-6
    };
    setResult(outcome);
    frame(view);
    offerPoster(view);
    report.current?.({ phase: 'checked', ...outcome });
  }

  /**
   * Lets the form render the catalogue poster from this very scene when it
   * saves — the model already parsed, checked and at its true size, so it is
   * never read a second time just to take its picture (app/portal/poster.js).
   */
  function offerPoster(view) {
    if (!posterRef || !view.renderer) return;
    const key = latest.current.sourceKey;
    posterRef.current = {
      sourceKey: key,
      render: async () => {
        if (sceneRef.current !== view) throw new Error('The preview has changed.');
        const { renderPoster } = await import('./poster.js');
        return renderPoster(view.THREE, view.model);
      }
    };
  }

  /** Move the camera, never the model, until the whole piece is in view. */
  function frame(view) {
    if (!view.renderer) return;
    const { THREE, model, camera, controls } = view;
    const { box, extent } = measure(THREE, model);
    const centre = box.getCenter(new THREE.Vector3());
    const radius = Math.max(0.5 * Math.hypot(extent.width, extent.height, extent.depth), 1e-3);
    const fov = THREE.MathUtils.degToRad(camera.fov);
    const distance = (radius / Math.sin(fov / 2)) * 1.08;
    const direction = new THREE.Vector3(0.75, 0.5, 1).normalize();
    camera.position.copy(centre).addScaledVector(direction, distance);
    camera.near = distance / 100;
    camera.far = distance * 100;
    camera.updateProjectionMatrix();
    controls.target.copy(centre);
    controls.minDistance = radius * 0.6;
    controls.maxDistance = distance * 4;
    controls.update();

    // A floor grid in 10 cm squares: a real ruler under the piece.
    if (view.grid) {
      view.scene.remove(view.grid);
      view.grid.geometry.dispose();
      view.grid.material.dispose();
    }
    const footprint = Math.max(extent.width, extent.depth);
    const size = Math.max(Math.ceil(footprint * 1.6 * 10) / 10, 0.4);
    const ink = getComputedStyle(canvasRef.current).getPropertyValue('--ink-faint').trim() || '#48535a';
    const grid = new THREE.GridHelper(size, Math.round(size * 10), ink, ink);
    grid.material.transparent = true;
    grid.material.opacity = 0.28;
    view.scene.add(grid);
    view.grid = grid;
    view.home = { position: camera.position.clone(), target: centre.clone() };
    view.render();
  }

  function resetView() {
    const view = sceneRef.current;
    if (!view?.home) return;
    view.camera.position.copy(view.home.position);
    view.controls.target.copy(view.home.target);
    view.controls.update();
    view.render();
  }

  const status = result?.status;
  const mismatch = status === SCALE_STATUS.PROPORTION_MISMATCH || status === SCALE_STATUS.BOUNDS_MISMATCH;
  const dimensionsSet = Boolean(dimensionsCm);
  const checks = [
    {
      label: 'Physical size set',
      state: dimensionsSet ? 'done' : 'pending',
      detail: dimensionsSet ? formatDimensions(dimensionsCm, unit) : 'Enter width, depth and height'
    },
    {
      label: 'Model proportions match',
      state: phase !== 'ready' || !dimensionsSet ? 'pending' : mismatch ? 'problem' : status === SCALE_STATUS.READY ? 'done' : 'pending'
    },
    {
      label: 'Model sits on the floor',
      state: phase === 'ready' && result?.floorOk ? 'done' : 'pending'
    },
    {
      label: 'Ready for AR',
      state: phase === 'ready' && result?.verified ? 'done' : mismatch ? 'problem' : 'pending'
    }
  ];

  return (
    <div className="model-preview" data-state={phase}>
      <div className="model-preview-stage" data-drawn={drawn ? 'true' : undefined}>
        <canvas ref={canvasRef} aria-label="3D preview of the model. Drag to turn it, scroll or pinch to zoom." role="img" />
        {phase === 'ready' && drawable && dimensionsSet && (
          <p className="model-preview-size" aria-hidden="true">
            <span>W {formatLength(dimensionsCm.width, unit)}</span>
            <span>D {formatLength(dimensionsCm.depth, unit)}</span>
            <span>H {formatLength(dimensionsCm.height, unit)}</span>
          </p>
        )}
        {phase === 'ready' && drawable && (
          <button type="button" className="model-preview-reset" onClick={resetView}>
            <ArrowCounterClockwise size={16} weight="bold" aria-hidden="true" />
            <span>Reset view</span>
          </button>
        )}
        {phase === 'empty' && (
          <p className="model-preview-note">
            Choose a <code>.glb</code> model and it appears here at the size you entered, before anything is uploaded.
          </p>
        )}
        {phase === 'loading' && (
          <p className="model-preview-note" role="status">
            <span className="loading-spinner" aria-hidden="true" /> Reading the model…
          </p>
        )}
        {phase === 'ready' && drawable && !drawn && (
          <p className="model-preview-note model-preview-drawing" role="status">
            <span className="loading-spinner" aria-hidden="true" /> Drawing the preview…
          </p>
        )}
        {phase === 'ready' && !drawable && (
          <p className="model-preview-note">
            This device can&rsquo;t draw the 3D preview, but the model was read and checked below.
          </p>
        )}
        {phase === 'failed' && (
          <div className="model-preview-note is-error" role="alert">
            <b>{FAILURES[failure]?.title || 'This model could not be opened.'}</b>
            <span>{FAILURES[failure]?.detail}</span>
            {onReplaceModel && failure !== 'access' && (
              <button type="button" className="button button-outline" onClick={onReplaceModel}>Choose another file</button>
            )}
          </div>
        )}
      </div>

      {phase === 'ready' && drawable && (
        <p className="model-preview-hint">Drag to turn · scroll or pinch to zoom · the grid is 10 cm squares</p>
      )}

      {mismatch && result?.decision && (
        <section className="scale-attention" role="alert" aria-labelledby="scale-attention-title">
          <h3 id="scale-attention-title">
            <WarningCircle size={18} weight="bold" aria-hidden="true" />
            {status === SCALE_STATUS.PROPORTION_MISMATCH
              ? 'Model proportions don’t match the furniture dimensions'
              : 'The model doesn’t measure the furniture dimensions'}
          </h3>
          <dl>
            <div><dt>Entered size</dt><dd>{formatDimensions(dimensionsCm, unit)}</dd></div>
            <div><dt>Model proportion</dt><dd>{result.decision.modelProportion}</dd></div>
            <div><dt>Expected proportion</dt><dd>{result.decision.expectedProportion}</dd></div>
          </dl>
          <p className="scale-attention-note">
            Proportions are width : depth : height. FurnishAR won&rsquo;t stretch a model to fit, because that would distort the furniture.
            {existing ? ' Shoppers won’t see this model in AR until it matches.' : ' It can’t be saved for AR until it matches.'}
          </p>
          <div className="scale-attention-actions">
            {onReviewDimensions && <button type="button" className="button button-outline" onClick={onReviewDimensions}>Review dimensions</button>}
            {onReplaceModel && <button type="button" className="button button-outline" onClick={onReplaceModel}>Replace 3D model</button>}
          </div>
        </section>
      )}

      <ul className="scale-checks" aria-label="True-scale check">
        {checks.map(check => (
          <li key={check.label} data-state={check.state}>
            {check.state === 'done' && <Check size={14} weight="bold" aria-hidden="true" />}
            {check.state === 'problem' && <WarningCircle size={14} weight="bold" aria-hidden="true" />}
            {check.state === 'pending' && <Minus size={14} weight="bold" aria-hidden="true" />}
            <span>
              {check.label}
              <span className="sr-only">{check.state === 'done' ? ': done' : check.state === 'problem' ? ': needs attention' : ': not yet'}</span>
            </span>
            {check.detail && <small>{check.detail}</small>}
          </li>
        ))}
      </ul>
    </div>
  );
}

const FAILURES = {
  parse: {
    title: 'This file could not be read as a 3D model.',
    detail: 'It may be damaged, or not a .glb. Export it again from your 3D tool as glTF Binary (.glb).'
  },
  'empty-geometry': {
    title: 'This model has nothing in it to measure.',
    detail: 'Its geometry has no size on at least one side. Export it again with the full piece included.'
  },
  access: {
    title: 'The saved model could not be opened for preview.',
    detail: 'Signing in again usually fixes this. The model itself is unchanged.'
  },
  engine: {
    title: 'The 3D viewer did not finish loading.',
    detail: 'Check your connection and open this form again.'
  }
};

/** Identifies a size, so a result can be matched to the size it was checked against. */
export function dimensionsKey(dimensionsCm) {
  return dimensionsCm ? `${dimensionsCm.width}|${dimensionsCm.depth}|${dimensionsCm.height}` : '';
}

/** Identifies a model source the same way. */
export function modelSourceKey(source) {
  if (source?.file) return `file:${source.file.name}:${source.file.size}:${source.file.lastModified}`;
  return source?.path ? `path:${source.path}` : '';
}

/** A stored model reference → a URL the loader can fetch, as this account. */
async function resolvePath(path) {
  if (/^\/api\/sb\/model\//.test(path)) {
    // Protected: trade the reference for a five-minute signed URL, exactly as
    // the planner does. The file never becomes public for a preview.
    if (!usingSupabase() || !supabase()?.resolveModelUrl) throw new Error('unavailable');
    return supabase().resolveModelUrl(path);
  }
  return /^(https?:|\/)/.test(path) ? path : `/${path.replace(/^\.?\//, '')}`;
}

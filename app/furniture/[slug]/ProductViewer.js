'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { initBackend, usingSupabase, supabase, backendOutage, backendConfigured } from '../../portal/backend.js';
import { noticeExpiredSession } from '../../alerts/sessionExpiry.js';

/**
 * The product's own 3D model, turnable.
 *
 * The states, and the viewer is explicit about which one it is in, because
 * they mean different things to a shopper and to the shop:
 *
 *   loading   the model is on its way — a skeleton, never a spinner over an
 *             empty box that might be the product
 *   ready     the real thing, orbitable
 *   locked    nobody is signed in. The model is not public (0007): the page,
 *             the photo and the dimensions are; turning the real piece in 3D
 *             needs an account. Says so, with a sign-in that comes back here.
 *   refused   signed in, and the server said no — a piece that is no longer
 *             published. Not "failed": trying again will not change it.
 *   offline   the request never reached the server. Says that, with a retry.
 *   unavailable  the database is configured but not usable, so the catalogue
 *             is showing its bundled copy, whose demo model only a deployment
 *             WITHOUT a database serves. Nothing to retry; says so plainly.
 *   failed    the model exists but would not load. Says so, offers a retry,
 *             and never falls back to a picture of something else.
 *   none      no model was ever uploaded. Also says so. This is a different
 *             sentence from "failed", because the shop's next action differs.
 *
 * WHERE THE MODEL COMES FROM
 * product.modelGlb is a reference, not a file. For a signed-in account it is
 * traded for a five-minute signed URL (resolveModelUrl); for a guest there is
 * nothing to trade, so no request is made and three.js is not even loaded.
 * The demo catalogue's bundled model is a plain URL; it loads as it is on a
 * deployment without a database, and is not asked for on one with a database.
 *
 * The one thing it must never do is substitute. A viewer that quietly shows a
 * generic armchair when chair.glb 404s is worse than an error: the shopper
 * measures their doorway against furniture that is not the furniture.
 *
 * ACCESSIBILITY
 * Orbiting is a mouse gesture, so everything it does is also on the keyboard:
 * arrows turn, +/- zoom, 0 resets, and the canvas is a labelled, focusable
 * application region that announces what it is. The dimensions are in the DOM
 * beside it regardless — someone who cannot use the viewer at all still gets
 * the numbers, which is the information the viewer exists to convey.
 */
export default function ProductViewer({ product }) {
  const mountRef = useRef(null);
  const canvasRef = useRef(null);
  const apiRef = useRef(null);
  const [state, setState] = useState(product.modelGlb ? 'idle' : 'none');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!product.modelGlb) {
      setState('none');
      return undefined;
    }
    const mount = mountRef.current;
    const canvas = canvasRef.current;
    if (!mount || !canvas) return undefined;

    let cancelled = false;
    let teardown = null;

    // Only load when the viewer is actually approaching the viewport. On a
    // product page it usually is, but a deep-linked anchor further down the
    // page should not pull a model nobody has looked at.
    const observer = new IntersectionObserver(
      entries => {
        if (!entries.some(e => e.isIntersecting)) return;
        observer.disconnect();
        start().then(stop => {
          if (cancelled) stop?.();
          else teardown = stop;
        });
      },
      { rootMargin: '200px' }
    );
    observer.observe(mount);

    /* Who may see this model, answered before anything heavy is fetched. */
    async function resolveSource() {
      const reference = product.modelGlb;
      await initBackend();
      if (!reference.startsWith('/api/sb/model/')) {
        /* The bundled demo model is served only where there is no database
           at all. A deployment WITH one — even one that is down — refuses it,
           so asking would only buy a 404 and a misleading "failed". This is
           the catalogue's fallback copy showing while the real one cannot. */
        if (backendConfigured()) return { issue: backendOutage() ? 'offline' : 'unavailable' };
        return { url: reference };
      }
      const sb = supabase();
      if (!usingSupabase() || !sb?.resolveModelUrl) return { issue: backendOutage() ? 'offline' : 'failed' };
      const session = await sb.getSession().catch(() => null);
      if (!session) {
        /* Nobody signed in — or a session that just failed to renew, which
           deserves "expired" rather than a first-visit sign-in. */
        await noticeExpiredSession(sb, window.location.pathname);
        return { issue: 'locked' };
      }
      try {
        return { url: await sb.resolveModelUrl(reference) };
      } catch (error) {
        if (error?.code === 'session_expired' || error?.code === 'auth_required') {
          /* Signed in once, not any more: say it expired (an alert that
             stays until read), drop the dead session, then show the gate. */
          await noticeExpiredSession(sb, window.location.pathname);
          return { issue: 'locked' };
        }
        if (error?.code === 'unavailable') return { issue: 'refused' };
        if (error instanceof TypeError) return { issue: 'offline' };
        return { issue: 'failed' };
      }
    }

    async function start() {
      setState('loading');
      const source = await resolveSource();
      if (cancelled) return null;
      if (source.issue) {
        setState(source.issue);
        return null;
      }

      let THREE;
      let GLTFLoader;
      let MeshoptDecoder;
      let DRACOLoader;
      try {
        [THREE, { GLTFLoader }, { MeshoptDecoder }, { DRACOLoader }] = await Promise.all([
          import('three'),
          import('three/examples/jsm/loaders/GLTFLoader.js'),
          import('three/examples/jsm/libs/meshopt_decoder.module.js'),
          import('three/examples/jsm/loaders/DRACOLoader.js')
        ]);
      } catch {
        setState('failed');
        return null;
      }
      if (cancelled) return null;

      let renderer;
      try {
        renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
      } catch {
        setState('failed');
        return null;
      }
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.1;

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 100);

      // The same neutral studio the thumbnails are rendered in, so opening a
      // card does not change how the product looks.
      scene.add(new THREE.HemisphereLight(0xffffff, 0xc9c5bb, 2.0));
      const key = new THREE.DirectionalLight(0xfff6ec, 2.2);
      key.position.set(3, 5, 4);
      scene.add(key);
      const fill = new THREE.DirectionalLight(0xeaf0ff, 0.7);
      fill.position.set(-4, 2, -3);
      scene.add(fill);

      const pivot = new THREE.Group();
      scene.add(pivot);

      const loader = new GLTFLoader();
      loader.setMeshoptDecoder(MeshoptDecoder);
      loader.setDRACOLoader(new DRACOLoader().setDecoderPath('/draco/'));

      let model;
      try {
        const gltf = await loader.loadAsync(source.url);
        model = gltf.scene;
      } catch {
        renderer.dispose();
        // Explicitly failed, NOT "none" and NOT a substituted image.
        setState('failed');
        return null;
      }
      if (cancelled) {
        renderer.dispose();
        return null;
      }

      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const centre = box.getCenter(new THREE.Vector3());
      const longest = Math.max(size.x, size.y, size.z) || 1;
      model.scale.setScalar(1 / longest);
      model.position.copy(centre).multiplyScalar(-1 / longest);
      pivot.add(model);

      setState('ready');

      // Orbit state. Kept here rather than in React: it changes every frame
      // of a drag, and re-rendering a component sixty times a second to move
      // a camera is how a viewer starts dropping frames.
      const HOME = { yaw: -0.6, pitch: 0.18, distance: 2.6 };
      let yaw = HOME.yaw;
      let pitch = HOME.pitch;
      let distance = HOME.distance;

      const MIN_PITCH = -0.4;
      const MAX_PITCH = 1.1;
      const MIN_DISTANCE = 1.5;
      const MAX_DISTANCE = 4.5;

      let frame = 0;
      const draw = () => {
        frame = 0;
        camera.position.set(
          Math.sin(yaw) * Math.cos(pitch) * distance,
          Math.sin(pitch) * distance,
          Math.cos(yaw) * Math.cos(pitch) * distance
        );
        camera.lookAt(0, 0, 0);
        renderer.render(scene, camera);
      };
      const schedule = () => {
        if (!frame) frame = requestAnimationFrame(draw);
      };

      const resize = () => {
        const rect = canvas.getBoundingClientRect();
        renderer.setSize(rect.width, rect.height, false);
        camera.aspect = rect.width / Math.max(rect.height, 1);
        camera.updateProjectionMatrix();
        schedule();
      };
      resize();

      /* ---- pointer ---- */
      let dragging = false;
      let lastX = 0;
      let lastY = 0;

      const onDown = event => {
        dragging = true;
        lastX = event.clientX;
        lastY = event.clientY;
        canvas.setPointerCapture?.(event.pointerId);
      };
      const onMove = event => {
        if (!dragging) return;
        yaw -= (event.clientX - lastX) * 0.01;
        pitch = Math.min(MAX_PITCH, Math.max(MIN_PITCH, pitch + (event.clientY - lastY) * 0.006));
        lastX = event.clientX;
        lastY = event.clientY;
        schedule();
      };
      const onUp = event => {
        dragging = false;
        canvas.releasePointerCapture?.(event.pointerId);
      };

      // Wheel zooms, but only once the viewer has focus or the pointer is
      // over it AND the gesture is deliberate — otherwise scrolling the page
      // past a product traps the scroll in the viewer, which is one of the
      // most disliked things a 3D embed can do. preventDefault only when we
      // actually consume it.
      const onWheel = event => {
        if (!event.ctrlKey && Math.abs(event.deltaY) < 40) return;
        event.preventDefault();
        distance = Math.min(MAX_DISTANCE, Math.max(MIN_DISTANCE, distance + event.deltaY * 0.002));
        schedule();
      };

      /* ---- keyboard: everything the mouse can do ---- */
      const onKey = event => {
        const step = event.shiftKey ? 0.28 : 0.12;
        switch (event.key) {
          case 'ArrowLeft': yaw += step; break;
          case 'ArrowRight': yaw -= step; break;
          case 'ArrowUp': pitch = Math.min(MAX_PITCH, pitch + step * 0.6); break;
          case 'ArrowDown': pitch = Math.max(MIN_PITCH, pitch - step * 0.6); break;
          case '+': case '=': distance = Math.max(MIN_DISTANCE, distance - 0.2); break;
          case '-': case '_': distance = Math.min(MAX_DISTANCE, distance + 0.2); break;
          case '0':
            yaw = HOME.yaw; pitch = HOME.pitch; distance = HOME.distance;
            break;
          default: return;
        }
        event.preventDefault();
        schedule();
      };

      canvas.addEventListener('pointerdown', onDown);
      canvas.addEventListener('pointermove', onMove);
      canvas.addEventListener('pointerup', onUp);
      canvas.addEventListener('pointercancel', onUp);
      canvas.addEventListener('wheel', onWheel, { passive: false });
      canvas.addEventListener('keydown', onKey);
      window.addEventListener('resize', resize);

      // Exposed so the reset button outside the canvas can drive it.
      apiRef.current = {
        reset: () => {
          yaw = HOME.yaw; pitch = HOME.pitch; distance = HOME.distance;
          schedule();
        }
      };

      return () => {
        if (frame) cancelAnimationFrame(frame);
        canvas.removeEventListener('pointerdown', onDown);
        canvas.removeEventListener('pointermove', onMove);
        canvas.removeEventListener('pointerup', onUp);
        canvas.removeEventListener('pointercancel', onUp);
        canvas.removeEventListener('wheel', onWheel);
        canvas.removeEventListener('keydown', onKey);
        window.removeEventListener('resize', resize);
        apiRef.current = null;
        scene.traverse(node => {
          if (node.geometry) node.geometry.dispose();
          const materials = Array.isArray(node.material) ? node.material : [node.material];
          for (const material of materials) {
            if (!material) continue;
            for (const value of Object.values(material)) value?.isTexture && value.dispose();
            material.dispose();
          }
        });
        renderer.dispose();
      };
    }

    return () => {
      cancelled = true;
      observer.disconnect();
      teardown?.();
    };
  }, [product.modelGlb, attempt]);

  const dims = product.dimensions;
  const signIn = `/login?as=buyer&next=${encodeURIComponent(`/furniture/${product.slug || product.id}`)}`;

  return (
    <div className="viewer" ref={mountRef} data-state={state}>
      <div className="viewer-stage">
        {/*
          A canvas is not focusable and announces nothing, so it is given a
          role, a name and a tabindex. The instructions are in the accessible
          description rather than only in the visible hint, because someone
          arriving by keyboard needs them before they can see the hint.
        */}
        <canvas
          className="viewer-canvas"
          ref={canvasRef}
          tabIndex={state === 'ready' ? 0 : -1}
          role="application"
          aria-label={
            state === 'ready'
              ? `${product.name}, interactive 3D model. Arrow keys turn it, plus and minus zoom, zero resets.`
              : `${product.name} 3D model`
          }
        />

        {state === 'loading' && (
          <div className="viewer-overlay" role="status">
            <span className="viewer-skeleton" aria-hidden="true" />
            <p>Loading the 3D model…</p>
          </div>
        )}

        {state === 'failed' && (
          <div className="viewer-overlay viewer-overlay-message" role="alert">
            <p><b>3D preview unavailable</b></p>
            <p className="viewer-note">
              This product has a 3D model, but it could not be loaded. The
              dimensions below are still accurate.
            </p>
            <button type="button" className="button" onClick={() => setAttempt(n => n + 1)}>
              Try again
            </button>
          </div>
        )}

        {state === 'locked' && (
          <div className="viewer-overlay viewer-overlay-message">
            <p><b>Sign in to view this furniture in 3D.</b></p>
            <p className="viewer-note">
              The 3D model needs a free account. The measurements below are
              open to everyone.
            </p>
            <div className="viewer-actions">
              <Link className="button button-primary" href={signIn}>
                Log in <span aria-hidden="true">→</span>
              </Link>
              <Link className="button" href={`${signIn}&mode=signup`}>Create account</Link>
            </div>
          </div>
        )}

        {state === 'refused' && (
          <div className="viewer-overlay viewer-overlay-message" role="alert">
            <p><b>3D preview is unavailable for this account.</b></p>
            <p className="viewer-note">
              This piece&rsquo;s model is not open to view right now. The
              dimensions below are still accurate.
            </p>
          </div>
        )}

        {state === 'offline' && (
          <div className="viewer-overlay viewer-overlay-message" role="alert">
            <p><b>Connection failed</b></p>
            <p className="viewer-note">
              Check your internet connection and try again.
            </p>
            <button
              type="button"
              className="button"
              onClick={() => {
                /* An outage found as the page started is remembered by
                   initBackend(); only a fresh load asks again. */
                if (backendOutage()) window.location.reload();
                else setAttempt(n => n + 1);
              }}
            >
              Try again
            </button>
          </div>
        )}

        {state === 'unavailable' && (
          <div className="viewer-overlay viewer-overlay-message">
            <p><b>3D preview is unavailable right now.</b></p>
            <p className="viewer-note">
              The dimensions below are still accurate.
            </p>
          </div>
        )}

        {state === 'none' && (
          <div className="viewer-overlay viewer-overlay-message">
            <p><b>No 3D model yet</b></p>
            <p className="viewer-note">
              {product.store} has not uploaded a model for this piece, so it
              cannot be placed in your room. The measurements below come from
              the shop.
            </p>
          </div>
        )}
      </div>

      {state === 'ready' && (
        <div className="viewer-controls">
          <p className="viewer-hint">Drag to turn · scroll to zoom</p>
          <button
            type="button"
            className="button viewer-reset"
            onClick={() => apiRef.current?.reset()}
          >
            Reset view
          </button>
        </div>
      )}

      {/*
        The measurements, always present in the DOM whatever the viewer is
        doing. This is the fallback that matters: the viewer's job is to help
        someone judge size, and these are the size.
      */}
      <dl className="viewer-dims">
        <div><dt>Width</dt><dd>{dims.width} cm</dd></div>
        <div><dt>Depth</dt><dd>{dims.depth} cm</dd></div>
        <div><dt>Height</dt><dd>{dims.height} cm</dd></div>
      </dl>
    </div>
  );
}

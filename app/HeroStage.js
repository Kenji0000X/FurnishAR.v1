'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * The room that travels down the page.
 *
 * One WebGL canvas, pinned behind the first three sections, holding one model.
 * Scrolling does not start a new animation — it *is* the animation: the page's
 * scroll offset is the only input, and every frame is a pure function of it.
 * That is what makes it feel attached to the page rather than triggered by it,
 * and it is also why scrubbing backwards looks identical to scrubbing forwards.
 *
 * WHY THIS IS NOT JUST "ADD THREE.JS TO THE HOME PAGE"
 * A landing page that ships a renderer is a landing page that can be slow in
 * four separate ways, and all four had to be answered before this was worth
 * doing at all:
 *
 *   the file      2.0M triangles and 5.5 MB as delivered. Simplified to 71k
 *                 and 598 KB (meshopt + 512px WebP) before it entered the
 *                 repo — a 28x cut in geometry. At hero size the original
 *                 and the shipped one are indistinguishable; the difference
 *                 is a slightly rounder sofa edge nobody will ever look for.
 *                 scripts/check-hero-perf.mjs measured the step from 158k to
 *                 71k as 200ms to 117ms a frame on a software rasteriser,
 *                 which is what settled the number.
 *   the bundle    three.js is ~600 KB. It is imported inside an effect, after
 *                 an IntersectionObserver says the stage is near, so the HTML,
 *                 the CSS and the catalogue are never waiting on it. Someone
 *                 who lands and immediately scrolls to the FAQ downloads no
 *                 renderer at all.
 *   the frames    device pixel ratio is capped (phones ship 3x and there is
 *                 nothing to see at 3x on a soft-lit interior), the loop stops
 *                 when the stage leaves the viewport or the tab is hidden, and
 *                 nothing re-renders when the scroll position has not moved.
 *   the fallback  no WebGL, reduced motion, or Save-Data all resolve to the
 *                 same still image, which is a real render of the same model
 *                 at the same angle rather than an apology.
 *
 * The AR planner has its own renderer and its own lifetime. This one is
 * deliberately separate and much smaller: no XR, no hit-testing, no controls.
 */

/**
 * Where the room is at each point of the scroll.
 *
 * `at` is progress through the pinned range, 0 to 1. Everything between two
 * keyframes is interpolated, so adding a section means adding a keyframe, not
 * writing another animation.
 *
 * Positions are in viewport-relative units: x is a fraction of the visible
 * width from centre, so the composition holds from 360px to 2560px instead of
 * drifting off the side of a wide monitor.
 */
const KEYFRAMES = [
  // Hero: right of the headline, tucked under the capsule rail.
  { at: 0.00, x: 0.17, y: -0.01, scale: 0.94, rotY: -0.55, rotX: 0.07 },
  // Handing over to the story: swings left and turns to face the text.
  //
  // The scale stays near 1 through all three. The first pass grew it to 1.16
  // here on the theory that closer is more dramatic, and what it actually did
  // was push the coffee table on top of the second paragraph and run the
  // shelving off the left edge. The room is the page's companion through this
  // stretch, not its subject — it moves and turns, it does not loom.
  { at: 0.38, x: -0.27, y: -0.02, scale: 0.96, rotY: 0.30, rotX: 0.10 },
  // The three promises: settles, turning slowly.
  { at: 0.72, x: -0.26, y: 0.00, scale: 1.02, rotY: 0.95, rotX: 0.06 },
  // Leaves toward the catalogue.
  { at: 1.00, x: -0.21, y: 0.08, scale: 0.96, rotY: 1.45, rotX: 0.03 }
];

/** Cubic ease-out — the curve the rest of the stylesheet already uses. */
const ease = t => 1 - Math.pow(1 - t, 3);

/** Reads the keyframe track at `progress`, blending the two it sits between. */
function sample(progress) {
  const p = Math.min(1, Math.max(0, progress));
  let a = KEYFRAMES[0];
  let b = KEYFRAMES[KEYFRAMES.length - 1];
  for (let i = 0; i < KEYFRAMES.length - 1; i += 1) {
    if (p >= KEYFRAMES[i].at && p <= KEYFRAMES[i + 1].at) {
      a = KEYFRAMES[i];
      b = KEYFRAMES[i + 1];
      break;
    }
  }
  const span = b.at - a.at || 1;
  const t = ease((p - a.at) / span);
  const mix = (from, to) => from + (to - from) * t;
  return {
    x: mix(a.x, b.x),
    y: mix(a.y, b.y),
    scale: mix(a.scale, b.scale),
    rotY: mix(a.rotY, b.rotY),
    rotX: mix(a.rotX, b.rotX)
  };
}

export default function HeroStage({ children }) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  // 'idle' until the stage is worth loading for, then 'loading', then 'live'.
  // 'still' is every reason to show the poster instead: no WebGL, reduced
  // motion, Save-Data, or a load that failed.
  const [mode, setMode] = useState('idle');

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return undefined;

    // Three separate ways to say "not on this device, not right now". All of
    // them are honoured before a single byte of the renderer is fetched.
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const saveData = navigator.connection?.saveData === true;
    if (reducedMotion || saveData) {
      setMode('still');
      return undefined;
    }

    let cancelled = false;
    let teardown = null;

    // Only pay for the renderer once the stage is actually approaching. A
    // visitor who lands and jumps to the catalogue never downloads it.
    const observer = new IntersectionObserver(
      entries => {
        if (!entries.some(entry => entry.isIntersecting)) return;
        observer.disconnect();
        setMode('loading');
        start().then(stop => {
          if (cancelled) stop?.();
          else teardown = stop;
        });
      },
      { rootMargin: '300px' }
    );
    observer.observe(wrap);

    async function start() {
      let THREE;
      let GLTFLoader;
      let MeshoptDecoder;
      try {
        [THREE, { GLTFLoader }, { MeshoptDecoder }] = await Promise.all([
          import('three'),
          import('three/examples/jsm/loaders/GLTFLoader.js'),
          import('three/examples/jsm/libs/meshopt_decoder.module.js')
        ]);
      } catch {
        setMode('still');
        return null;
      }
      if (cancelled) return null;

      let renderer;
      try {
        renderer = new THREE.WebGLRenderer({
          canvas,
          alpha: true,
          antialias: true,
          powerPreference: 'high-performance',
          // Nothing reads the buffer back, and keeping it costs memory on
          // every resize.
          preserveDrawingBuffer: false
        });
      } catch {
        // No WebGL at all — an old phone, a locked-down browser, a VM.
        setMode('still');
        return null;
      }

      /*
        How many pixels this is allowed to rasterise, as an absolute budget
        rather than a device-pixel-ratio cap.

        A ratio cap alone is the wrong control, because the thing that costs
        money is the product of ratio and window size and those pull in
        opposite directions: a phone has a huge ratio and a tiny window, a
        desktop the reverse. Capping at 1.6x looked careful and still handed a
        1440x900 window a 2304x1440 buffer — 3.3 megapixels, every frame, to
        decorate a headline. Measured under a software rasteriser that was
        ~170ms a frame.

        1.4 megapixels is roughly 1440x970. Above that the renderer scales the
        ratio down to fit. It is a soft-lit interior with almost no hard edges
        and it sits behind text, so the difference is not visible; the
        difference in fragment work is more than half.
      */
      const PIXEL_BUDGET = 1.4e6;
      const dpr = () => {
        const ratio = Math.min(window.devicePixelRatio || 1, 1.6);
        const rect = canvas.getBoundingClientRect();
        const area = Math.max(rect.width * rect.height, 1);
        return Math.min(ratio, Math.sqrt(PIXEL_BUDGET / area));
      };
      renderer.setPixelRatio(dpr());
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.15;

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
      camera.position.set(0, 0.35, 5.4);

      // Three lights, no environment map. An HDR would be another download
      // for a scene this simple, and the page's own light is flat and warm
      // anyway — that is the look, not a limitation.
      scene.add(new THREE.HemisphereLight(0xffffff, 0xb9b4a6, 2.1));
      const key = new THREE.DirectionalLight(0xfff4e6, 2.3);
      key.position.set(3, 5, 4);
      scene.add(key);
      const rim = new THREE.DirectionalLight(0xdfe8ff, 0.85);
      rim.position.set(-4, 2, -3);
      scene.add(rim);

      const pivot = new THREE.Group();
      scene.add(pivot);

      const loader = new GLTFLoader();
      loader.setMeshoptDecoder(MeshoptDecoder);

      let model;
      try {
        const gltf = await loader.loadAsync('/models/modern-living-room.glb');
        model = gltf.scene;
      } catch {
        renderer.dispose();
        setMode('still');
        return null;
      }
      if (cancelled) {
        renderer.dispose();
        return null;
      }

      // Normalise: whatever the author exported, it ends up 3 units across and
      // centred on its own bounding box, so the keyframes above are about
      // composition rather than about this particular file's origin.
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const centre = box.getCenter(new THREE.Vector3());
      // 2.3 units across. The camera sees 3.3 units of height at this depth,
      // so the room occupies a bit over half the frame and still has air
      // around it — at 3 it ran off the bottom of a 900px window and fought
      // the capsule rail for the same pixels.
      const unit = 2.3 / Math.max(size.x, size.y, size.z);
      model.scale.setScalar(unit);
      model.position.copy(centre).multiplyScalar(-unit);
      pivot.add(model);

      setMode('live');

      let width = 0;
      let height = 0;
      const resize = () => {
        const rect = canvas.getBoundingClientRect();
        width = rect.width;
        height = rect.height;
        renderer.setPixelRatio(dpr());
        renderer.setSize(width, height, false);
        camera.aspect = width / Math.max(height, 1);
        camera.updateProjectionMatrix();
      };
      resize();

      // The pinned range: how far the page scrolls while the stage is stuck.
      const progress = () => {
        const rect = wrap.getBoundingClientRect();
        const travel = rect.height - window.innerHeight;
        if (travel <= 0) return 0;
        return Math.min(1, Math.max(0, -rect.top / travel));
      };

      // Visible pixels → world units at the model's depth, so an x of 0.12
      // means the same slice of the composition on any screen.
      const worldPerViewport = () => {
        const visibleHeight = 2 * Math.tan((camera.fov * Math.PI) / 360) * camera.position.z;
        return { x: visibleHeight * camera.aspect, y: visibleHeight };
      };

      /**
       * The phone composition, which is a different composition — not the
       * desktop one squeezed.
       *
       * Desktop puts the room BESIDE the text in a two-column hero. A phone
       * has one column, so beside is not available: the choice is behind, or
       * below. Behind means every headline is set over a sofa and needs a
       * panel to stay readable, which is three panels of apology across the
       * page. Below is better — the copy takes the top of the screen and the
       * room takes the bottom, and neither is in the other's way.
       *
       * So on a narrow screen the whole track is pushed down and pulled to
       * the middle, and the model is shrunk to fit a portrait frame. The
       * keyframes above stay exactly as they are; this is an offset applied
       * to whatever they say, so there is still only one track to reason
       * about.
       */
      const narrow = () => width > 0 && width < 900;
      const forPhone = k => {
        if (!narrow()) return k;
        return {
          // Centre it: at 390px there is no left half and right half.
          x: k.x * 0.25,
          // DOWN into the lower third, clear of the copy above. Negative,
          // because +Y is up in three.js — the first version of this line
          // added instead of subtracted and lifted the room straight into
          // the middle of the headline.
          y: k.y - 0.10,
          // A portrait frame is short, and the room is a wide object.
          scale: k.scale * 0.80,
          rotY: k.rotY,
          rotX: k.rotX
        };
      };

      let frame = 0;
      let running = true;
      // Smoothed scroll target. The raw value is already continuous, but a
      // trackpad fling arrives in coarse jumps and the model should arrive
      // just after the text rather than snapping with it.
      let current = progress();
      let spin = 0;

      const draw = () => {
        frame = 0;
        if (!running) return;

        const target = progress();
        current += (target - current) * 0.12;
        // A slow idle turn, so the room is alive even when nobody scrolls.
        spin += 0.0012;

        const k = forPhone(sample(current));
        const world = worldPerViewport();
        pivot.position.set(k.x * world.x, k.y * world.y, 0);
        pivot.scale.setScalar(k.scale);
        pivot.rotation.y = k.rotY + spin;
        pivot.rotation.x = k.rotX;

        renderer.render(scene, camera);

        /*
          Two readings published for scripts/check-home-sections.mjs.

          Not a debug leftover. The triangle count is the only thing standing
          between this page and someone re-exporting the model without the
          simplification step — 158k quietly becoming 2M looks identical in a
          screenshot, in a build, and in every test that inspects the DOM. And
          the pose is how a check tells "the room travels with the scroll"
          apart from "the canvas is an expensive photograph that happens to
          look right at the top of the page".

          Both are plain numbers, written once a frame, read by nothing in the
          app itself.
        */
        window.__furnisharStagePose = { x: k.x, y: k.y, scale: k.scale, rotY: k.rotY };
        window.__furnisharStageInfo = {
          triangles: renderer.info.render.triangles,
          calls: renderer.info.render.calls
        };

        // Keep going while it still has somewhere to get to; otherwise idle
        // on the slow spin alone at a much cheaper cadence.
        const settled = Math.abs(target - current) < 0.0002;
        if (!settled) schedule();
        else idle();
      };

      const schedule = () => {
        if (!frame && running) frame = requestAnimationFrame(draw);
      };

      // When nothing is moving but the room, 24fps is plenty and saves a
      // third of the GPU work of a full-rate loop.
      let idleTimer = 0;
      const idle = () => {
        clearTimeout(idleTimer);
        if (!running) return;
        idleTimer = setTimeout(schedule, 42);
      };

      const onScroll = () => schedule();
      const onResize = () => {
        resize();
        schedule();
      };

      // Stop entirely when the stage is off-screen or the tab is in the
      // background. A renderer running behind the FAQ is pure waste.
      const visibility = new IntersectionObserver(entries => {
        running = entries.some(entry => entry.isIntersecting);
        if (running) schedule();
        else {
          clearTimeout(idleTimer);
          if (frame) cancelAnimationFrame(frame);
          frame = 0;
        }
      });
      visibility.observe(wrap);

      const onVisibility = () => {
        if (document.hidden) {
          clearTimeout(idleTimer);
          if (frame) cancelAnimationFrame(frame);
          frame = 0;
        } else schedule();
      };

      window.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('resize', onResize);
      document.addEventListener('visibilitychange', onVisibility);
      schedule();

      return () => {
        running = false;
        clearTimeout(idleTimer);
        if (frame) cancelAnimationFrame(frame);
        visibility.disconnect();
        window.removeEventListener('scroll', onScroll);
        window.removeEventListener('resize', onResize);
        document.removeEventListener('visibilitychange', onVisibility);
        // Textures and geometry do not go away with the renderer; a route
        // change without this leaks the whole scene's GPU memory.
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
  }, []);

  return (
    <div className="hero-stage" ref={wrapRef} data-mode={mode}>
      {/* Pinned for the whole scroll range. aria-hidden and pointer-events
          none: it is scenery, it holds no information that is not also in the
          text beside it, and it must never eat a click meant for a link. */}
      <div className="hero-stage-pin" aria-hidden="true">
        <canvas className="hero-stage-canvas" ref={canvasRef} />
        <div className="hero-stage-still" />
      </div>
      <div className="hero-stage-flow">{children}</div>
    </div>
  );
}

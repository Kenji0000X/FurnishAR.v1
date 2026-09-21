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
 * Positions are measured against the PAGE'S CONTENT COLUMN, not the viewport:
 * `x` is a fraction of the hero's content box from its centre, and `width` is
 * the fraction of that box the room should span.
 *
 * That distinction is the whole reason this reads as composed rather than
 * floated. The layout is a max-width grid with gutters — the capsule rail is
 * pinned to the right of it, the headline to the left — so anything measured
 * against the raw viewport instead drifts away from both as the window
 * changes shape. It did: at 1440x900 the room's right edge lined up with the
 * rail, and at 1344x682 it sat 80px short of it with dead space beyond,
 * because a fixed fraction of a wider, shorter viewport is a different place
 * on the grid. Measuring the grid itself makes the two move together.
 *
 * `y` stays viewport-relative, because vertical placement is about the fold,
 * which is a property of the window rather than of the column.
 */
/*
 * A NOTE ON THE ANGLES, BECAUSE THEY ARE NOT ARBITRARY
 *
 * This room is a wide object: a sectional sofa with a chaise, a shelving
 * unit and a tall framed panel behind it. Turned end-on it collapses — the
 * sofa foreshortens into a stub, the panel becomes the biggest thing on
 * screen, and the whole scene reads as a pile of objects rather than a room.
 * Turned open, the sofa spreads, the chaise reads, the panel falls back into
 * being a backdrop and the poufs and table stage themselves in front of it.
 *
 * Rendered every 0.25rad from -1.10 to +0.75 and then finer around the
 * promising ones. The useful window is roughly -0.3 to +0.8, and it is best
 * around +0.35. Outside that, both ends look the same kind of wrong.
 *
 * The first version ran -0.55 -> 1.45, which started just outside the good
 * window and ended well past it: the hero was foreshortened, and by the last
 * section the room had turned end-on again. The whole track now lives inside
 * the window, so every frame of the scroll is an angle the room actually
 * looks good at, and the travel is a turn rather than a full revolution.
 */
/*
   One keyframe. The room is stationary.

   It used to be four, blended by scroll position: the room slid from the
   right of the headline across to the left, turning from 0.35 to 0.82 radians
   as you read. It was the single most expensive thing on the page — a full
   re-render of a 3D scene on every scroll event, for the whole pinned range —
   and what it bought was a piece of furniture wandering around underneath the
   text somebody was trying to read.

   Scroll-linked motion of an object that is not the subject of the scroll is
   noise, in the signal-to-noise sense: it competes for attention with the
   copy and it answers no question the reader has. The room is now framed once,
   well, and left alone. `at` is kept so sample() and the phone override below
   need no change, and so a future deliberate move has somewhere to go.
*/
const KEYFRAMES = [
  // y is +0.11 rather than centred because the room's BOUNDING BOX centre is
  // not its visual centre: the framed panel at the back is tall and empty, so
  // a box-centred room reads as sitting low and loses its legs to the fold on
  // a short window.
  //
  // x is +0.21, not the +0.14 it sat at while it was moving. A room that
  // drifts across the page can pass behind the headline for a moment and read
  // as depth; a stationary one parked there is just a sofa on top of the
  // words. Measured at 1280px: at 0.14 the room's left edge landed at 535px
  // and "Live with it." ended at 540 — they overlapped every time.
  //
  // 0.25 fixed the overlap and then ran the room 32–48px PAST the content
  // column at every width check:home measures. 0.21 is the value that clears
  // the copy at 1344 (a 155px gap) and still lands inside the column at 1920.
  { at: 0.00, x: 0.21, y: 0.11, width: 0.44, rotY: 0.35, rotX: 0.16 },
  { at: 1.00, x: 0.21, y: 0.11, width: 0.44, rotY: 0.35, rotX: 0.16 }
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
    width: mix(a.width, b.width),
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

      // Normalise: whatever the author exported, it ends up exactly one unit
      // on its longest axis and centred on its own bounding box. One unit,
      // not some chosen size, because the keyframes now say how wide the room
      // should be as a fraction of the page's column — so the scale is
      // computed per frame from the layout rather than baked in here.
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const centre = box.getCenter(new THREE.Vector3());
      const longest = Math.max(size.x, size.y, size.z);
      const unit = 1 / longest;
      model.scale.setScalar(unit);
      model.position.copy(centre).multiplyScalar(-unit);
      pivot.add(model);

      // How tall the room is once it is one unit wide. Used to stop a short
      // window from cropping its legs off.
      const aspectOfModel = size.y / longest;

      /*
        Where the room actually lands on screen, in CSS pixels.

        Called on demand by scripts/check-home-sections.mjs, never per frame.
        It exists because the bug it guards is invisible to every other kind
        of test: the room drifting out of alignment with the capsule rail as
        the window changes shape produced no error, no overflow and no failing
        assertion — it just looked wrong, on one window size, to a person.

        Projects the eight corners of the model's box through the camera and
        takes their screen-space extent.
      */
      window.__furnisharStageBounds = () => {
        /*
          Renders one frame into a small offscreen target and reports the
          extent of the pixels that actually came out opaque.

          The obvious implementation — project the model's bounding box and
          take its screen extent — was tried and is wrong for this question.
          An axis-aligned box around a rotated room is much larger than the
          room: it reported the furniture ending 200-280px further right than
          it visibly does, consistently, at every window size. Consistently
          wrong is the worst kind for a threshold, because it looks like a
          real offset you could tune away.

          128px wide is plenty to find an edge to within a few CSS pixels, and
          keeps the readback small enough to be instant.
        */
        const probeW = 128;
        const probeH = Math.max(1, Math.round((probeW * height) / Math.max(width, 1)));
        const target = new THREE.WebGLRenderTarget(probeW, probeH);
        const previous = renderer.getRenderTarget();
        renderer.setRenderTarget(target);
        renderer.render(scene, camera);
        const pixels = new Uint8Array(probeW * probeH * 4);
        renderer.readRenderTargetPixels(target, 0, 0, probeW, probeH, pixels);
        renderer.setRenderTarget(previous);
        target.dispose();

        let minX = Infinity;
        let maxX = -Infinity;
        let minY = Infinity;
        let maxY = -Infinity;
        for (let y = 0; y < probeH; y += 1) {
          for (let x = 0; x < probeW; x += 1) {
            // Alpha above a threshold, so antialiased fringe pixels do not
            // stretch the measurement by a column either side.
            if (pixels[(y * probeW + x) * 4 + 3] <= 40) continue;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
        if (minX === Infinity) return null;

        const sx = width / probeW;
        const sy = height / probeH;
        // readRenderTargetPixels starts at the BOTTOM-left, so y flips.
        return {
          left: minX * sx,
          right: (maxX + 1) * sx,
          top: (probeH - 1 - maxY) * sy,
          bottom: (probeH - minY) * sy
        };
      };

      setMode('live');

      let width = 0;
      let height = 0;
      // The hero's content box, in canvas pixels: where the grid actually
      // puts its columns, gutters and max-width included. Measured on resize
      // rather than per frame — it only changes when the layout does.
      let column = { centre: 0, width: 0 };

      const measureColumn = () => {
        const hero = wrap.querySelector('.hero');
        const canvasRect = canvas.getBoundingClientRect();
        if (!hero) {
          column = { centre: width / 2, width };
          return;
        }
        const rect = hero.getBoundingClientRect();
        const style = getComputedStyle(hero);
        const left = rect.left + parseFloat(style.paddingLeft || '0');
        const right = rect.right - parseFloat(style.paddingRight || '0');
        column = {
          centre: (left + right) / 2 - canvasRect.left,
          width: Math.max(right - left, 1)
        };
      };

      const resize = () => {
        const rect = canvas.getBoundingClientRect();
        width = rect.width;
        height = rect.height;
        renderer.setPixelRatio(dpr());
        renderer.setSize(width, height, false);
        camera.aspect = width / Math.max(height, 1);
        camera.updateProjectionMatrix();
        measureColumn();
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
          // Centred, not nudged toward one side.
          //
          // This was `k.x * 0.25`, which is a quarter of a DESKTOP offset —
          // and a desktop offset exists to move the room out from behind a
          // headline that sits beside it. On a phone the headline is above
          // it, so there is nothing to move out of the way of, and the
          // fraction just pushed the room right until it was clipped by the
          // screen edge: measured at 360, 390 and 430px, the painted pixels
          // ran to exactly the viewport width every time.
          //
          // -0.05, not 0: the room is seen from a corner, so the pixels it
          // actually paints are not symmetric about its pivot — measured at
          // 360, 390 and 430px the painted centre sat 14, 17 and 20px right
          // of the screen's, a consistent ~4% of the width. This takes that
          // back out.
          x: -0.05,
          // DOWN into the lower third, clear of the copy above. Negative,
          // because +Y is up in three.js — the first version of this line
          // added instead of subtracted and lifted the room straight into
          // the middle of the headline.
          y: k.y - 0.10,
          // The column IS the screen on a phone, so a width that reads as
          // generous beside a headline reads as enormous under one.
          width: k.width * 1.85,
          rotY: k.rotY,
          rotX: k.rotX
        };
      };

      /**
       * Turns a keyframe into a position and a scale, against the layout.
       *
       * The scale is clamped by the window's height as well as the column's
       * width: on a short, wide window (a laptop with browser chrome, which
       * is most of them) a room sized purely by the column runs its legs off
       * the bottom of the fold.
       */
      const place = k => {
        const world = worldPerViewport();
        const pxToWorld = world.x / Math.max(width, 1);

        // Wide enough to fill its share of the column...
        let scale = k.width * column.width * pxToWorld;
        // ...but never so tall that the room cannot stand in the window.
        //
        // 0.90, not 0.82: the clamp and the width fight each other, and at
        // 0.82 a deliberately larger room was being silently shrunk back to
        // the old size on any short window — the enlargement would have
        // shipped as a no-op for exactly the people who reported it. This is
        // still short of the full height, so the legs stay on.
        const tallest = 0.90 * world.y;
        if (scale * aspectOfModel > tallest) scale = tallest / aspectOfModel;

        const centrePx = column.centre + k.x * column.width;
        return {
          x: (centrePx - width / 2) * pxToWorld,
          y: k.y * world.y,
          scale
        };
      };

      let frame = 0;
      let running = true;
      // Smoothed scroll target. The raw value is already continuous, but a
      // trackpad fling arrives in coarse jumps and the model should arrive
      // just after the text rather than snapping with it.
      let current = progress();
      /* The model turns on its own. It is a 3D object and it should read as
         one — a still render of a sofa is just a photograph with a WebGL bill
         attached. This is the ONLY motion it has: it is not linked to scroll
         in any way (see KEYFRAMES, which are deliberately identical), so the
         room turns gently in place wherever you are on the page and never
         travels with it. */
      let spin = 0;

      const draw = () => {
        frame = 0;
        if (!running) return;

        const target = progress();
        current += (target - current) * 0.12;
        spin += 0.0012;

        const k = forPhone(sample(current));
        const at = place(k);
        pivot.position.set(at.x, at.y, 0);
        pivot.scale.setScalar(at.scale);
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

          renderedRotY is pivot.rotation.y itself, not k.rotY. The two used to
          differ by `spin`, an idle turn added on top of the keyframe that
          never stopped — a check comparing only k.rotY across two points in
          time would read "unchanged" while the model kept visibly rotating,
          which is exactly what happened here. Publishing the actual value
          Three.js is about to draw is what makes that class of bug provable
          rather than merely fixed-and-hoped.
        */
        window.__furnisharStagePose = {
          x: k.x, y: k.y, scale: at.scale, rotY: k.rotY, renderedRotY: pivot.rotation.y
        };
        window.__furnisharStageInfo = {
          triangles: renderer.info.render.triangles,
          calls: renderer.info.render.calls
        };

        /* Full rate while catching up, then the cheaper idle cadence — which
           still runs, because the spin still needs advancing. The room is
           never finished turning; it is only finished MOVING, and those are
           different things. */
        const settled = Math.abs(target - current) < 0.0002;
        if (!settled) schedule();
        else idle();
      };

      const schedule = () => {
        if (!frame && running) frame = requestAnimationFrame(draw);
      };

      // When nothing is moving but the room's own turn, 24fps is plenty and
      // saves a third of the GPU work of a full-rate loop.
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
        // The probe closes over the scene it just disposed, so leaving it on
        // window would hand the next route a function that reads freed GPU
        // objects.
        delete window.__furnisharStageBounds;
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

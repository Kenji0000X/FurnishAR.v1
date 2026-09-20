'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * What the shopper will see, shown to the shop before they publish it.
 *
 * A store owner filling this form has, until now, had a text box containing a
 * path and no way to know whether it points at the right file, whether the
 * piece is the right way up, or whether the upload worked at all. The first
 * person to find out was a shopper opening the listing.
 *
 * So: the actual model, rendered from the actual path, with the same lighting
 * and framing the catalogue and the product page use. What appears here is
 * what appears there.
 *
 * Deliberately small and slowly turning rather than orbitable. This is a
 * confirmation ("yes, that is my chair"), not an inspection tool — the shop
 * owner has the real chair. The rotation exists so a model that is lying on
 * its side or facing backwards is obvious within a second, which a still
 * three-quarter render can hide.
 */
export default function ModelPreview({ path, name }) {
  const canvasRef = useRef(null);
  const [state, setState] = useState(path ? 'loading' : 'empty');

  useEffect(() => {
    if (!path) {
      setState('empty');
      return undefined;
    }
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    let cancelled = false;
    let teardown = null;
    setState('loading');

    (async () => {
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
        return;
      }
      if (cancelled) return;

      let renderer;
      try {
        renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
      } catch {
        setState('failed');
        return;
      }
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.1;

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 100);
      camera.position.set(0, 0.3, 2.7);
      camera.lookAt(0, 0, 0);

      scene.add(new THREE.HemisphereLight(0xffffff, 0xc9c5bb, 2.0));
      const key = new THREE.DirectionalLight(0xfff6ec, 2.2);
      key.position.set(3, 5, 4);
      scene.add(key);

      const pivot = new THREE.Group();
      scene.add(pivot);

      const loader = new GLTFLoader();
      loader.setMeshoptDecoder(MeshoptDecoder);
      loader.setDRACOLoader(new DRACOLoader().setDecoderPath('/draco/'));

      // The path may be relative ("models/x.glb") exactly as it is typed into
      // the field, so it is resolved the same way the catalogue resolves it.
      const src = /^(https?:|\/)/.test(path) ? path : `/${path.replace(/^\.?\//, '')}`;

      let gltf;
      try {
        gltf = await loader.loadAsync(src);
      } catch {
        renderer.dispose();
        // Said plainly, and never papered over with a picture of something
        // else: a preview that shows a stock chair when the upload failed is
        // how a broken listing gets published.
        setState('failed');
        return;
      }
      if (cancelled) {
        renderer.dispose();
        return;
      }

      const model = gltf.scene;
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const centre = box.getCenter(new THREE.Vector3());
      const longest = Math.max(size.x, size.y, size.z) || 1;
      model.scale.setScalar(1 / longest);
      model.position.copy(centre).multiplyScalar(-1 / longest);
      pivot.add(model);

      setState('ready');

      const resize = () => {
        const rect = canvas.getBoundingClientRect();
        renderer.setSize(rect.width, rect.height, false);
        camera.aspect = rect.width / Math.max(rect.height, 1);
        camera.updateProjectionMatrix();
      };
      resize();

      let frame = 0;
      let running = true;
      // Stops for anyone who asked for less motion; the model is still there
      // and still theirs, it simply holds still.
      const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const tick = () => {
        if (!running) return;
        if (!still) pivot.rotation.y += 0.006;
        renderer.render(scene, camera);
        frame = requestAnimationFrame(tick);
      };
      pivot.rotation.y = -0.6;
      tick();

      const onResize = () => { resize(); };
      window.addEventListener('resize', onResize);

      teardown = () => {
        running = false;
        if (frame) cancelAnimationFrame(frame);
        window.removeEventListener('resize', onResize);
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
    })();

    return () => {
      cancelled = true;
      teardown?.();
    };
  }, [path]);

  return (
    <div className="model-preview" data-state={state}>
      <div className="model-preview-stage">
        <canvas ref={canvasRef} aria-hidden="true" />
        {state === 'empty' && (
          <p className="model-preview-note">
            No model yet. Upload a <code>.glb</code> and it will appear here —
            this is exactly what shoppers will see.
          </p>
        )}
        {state === 'loading' && <p className="model-preview-note" role="status">Loading your model…</p>}
        {state === 'failed' && (
          <p className="model-preview-note is-error" role="alert">
            <b>This model could not be loaded.</b> Check the path is right and
            the file is a valid <code>.glb</code>. Publishing now would list
            {' '}{name} without a working 3D preview.
          </p>
        )}
      </div>
      {state === 'ready' && (
        <p className="model-preview-caption">
          <span className="model-preview-ok" aria-hidden="true" />
          This is the model shoppers will see.
        </p>
      )}
    </div>
  );
}

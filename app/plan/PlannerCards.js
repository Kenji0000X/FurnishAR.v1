'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';

/**
 * The planner's three cards.
 *
 * Every id here is one the AR engine looks for by name. They are deliberately
 * unchanged from the vanilla markup so ar-engine.js could be moved across
 * without being rewritten — React renders the shell, the engine drives it.
 * Renaming anything in here means editing the engine too.
 *
 * React only ever renders these elements; it never re-renders them from state,
 * so there is no tug-of-war with the engine over their contents.
 */
function PlannerBody({ products }) {
  const searchParams = useSearchParams();
  const rootRef = useRef(null);
  const [failed, setFailed] = useState(null);

  const selectedId = searchParams.get('product');
  const autoStart = searchParams.get('ar') === '1';

  useEffect(() => {
    let teardown = null;
    let cancelled = false;

    // Imported here rather than at module scope: it reaches for WebGL and
    // navigator.xr, neither of which exists while the page is server-rendered.
    import('./ar-engine.js')
      .then(({ createPlanner }) => createPlanner({ products, selectedId, autoStart }))
      .then(cleanup => {
        if (cancelled) cleanup();
        else teardown = cleanup;
      })
      .catch(error => {
        console.error('[FurnishAR] the planner failed to start:', error);
        setFailed(error.message);
      });

    return () => {
      cancelled = true;
      // Unmounting with a live XR session would leave the camera running.
      if (teardown) teardown();
    };
    // Re-running this would tear down a session mid-measurement, so the engine
    // is mounted once and told which product to start on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div ref={rootRef}>
      <section className="planner-intro">
        <p className="eyebrow">Fit before you commit</p>
        <h1 id="planner-title">Your room, planned with confidence.</h1>
        <p>
          Choose a product, scan a doorway or free floor area, and get a clear fit check in
          centimeters.
        </p>
      </section>

      {failed && (
        <p className="form-error" role="alert">
          The planner could not start on this device: {failed}
        </p>
      )}

      <div className="planner-layout">
        <section className="planner-card product-picker" aria-labelledby="picker-title">
          <div className="card-heading">
            <span className="step-number">01</span>
            <div><p>Pick a product</p><h2 id="picker-title">What are you placing?</h2></div>
          </div>
          <div id="planner-product" className="planner-product" />
        </section>

        <section className="planner-card measure-card" aria-labelledby="measure-title">
          <div className="card-heading">
            <span className="step-number">02</span>
            <div><p>Measure your space</p><h2 id="measure-title">Room scan</h2></div>
          </div>

          <div className="mode-switch" role="radiogroup" aria-label="What to measure">
            <button
              type="button"
              className="mode-option is-active"
              data-measure-mode="clearance"
              role="radio"
              aria-checked="true"
            >
              Clearance
            </button>
            <button
              type="button"
              className="mode-option"
              data-measure-mode="area"
              role="radio"
              aria-checked="false"
            >
              Floor area
            </button>
            <button
              type="button"
              className="mode-option"
              data-measure-mode="room"
              role="radio"
              aria-checked="false"
            >
              Whole room
            </button>
          </div>

          <p className="card-copy" id="measure-copy">
            Aim at a textured, non-reflective floor in bright light. On Android Chrome, tap two
            points across the opening. Otherwise use the fields below.
          </p>

          <div id="clearance-fields">
            <div className="measurement-visual" aria-hidden="true">
              <span className="measure-point point-a">A</span>
              <span className="measure-line" />
              <span className="measure-point point-b">B</span>
              <span id="visual-distance">120 cm</span>
            </div>
            <div className="measurement-inputs">
              <label>
                Point A{' '}
                <input id="point-a" type="number" min="0" max="1000" defaultValue={0} inputMode="numeric" />{' '}
                cm
              </label>
              <label>
                Point B{' '}
                <input id="point-b" type="number" min="1" max="1000" defaultValue={120} inputMode="numeric" />{' '}
                cm
              </label>
            </div>
            <p className="measurement-result">
              <span>Measured clearance</span>
              <strong id="measured-distance">120 cm</strong>
            </p>
          </div>

          <div id="area-fields" hidden>
            <div className="measurement-inputs">
              <label>
                Floor area{' '}
                <input
                  id="floor-area"
                  type="number"
                  min="0.1"
                  max="500"
                  step="0.01"
                  defaultValue={12}
                  inputMode="decimal"
                />{' '}
                m²
              </label>
              <label>
                Longest side{' '}
                <input id="floor-span" type="number" min="10" max="2000" defaultValue={400} inputMode="numeric" />{' '}
                cm
              </label>
            </div>
            <p className="measurement-result">
              <span>Measured floor</span>
              <strong id="measured-area">12.0 m²</strong>
            </p>
            <p id="area-confidence" className="ar-status" aria-live="polite" />
          </div>

          {/*
            The whole-room result, kept on the page after the scan closes so
            the measurement outlives the session that produced it.

            Every value starts as an em dash and is only replaced by something
            the scan actually determined. A dimension the device could not
            measure stays a dash — it is never filled with a typical room's
            numbers to make the card look finished.
          */}
          <div id="room-fields" hidden>
            <div className="room-readout" aria-live="polite">
              <p><span>Length</span><b id="room-result-length">—</b></p>
              <p><span>Width</span><b id="room-result-width">—</b></p>
              <p><span>Height</span><b id="room-result-height">—</b></p>
              <p><span>Floor area</span><b id="room-result-area">—</b></p>
            </div>
            <p id="room-result-note" className="ar-status" aria-live="polite">
              Not scanned yet.
            </p>
          </div>

          <button id="ar-button" className="button button-primary" type="button">
            Scan with your camera
          </button>
          <p id="ar-status" className="ar-status" aria-live="polite">
            Checking AR support…
          </p>
        </section>

        <section className="planner-card verdict-card" aria-labelledby="verdict-title">
          <div className="card-heading">
            <span className="step-number">03</span>
            <div><p>Check the fit</p><h2 id="verdict-title">Clearance verdict</h2></div>
          </div>
          <div id="fit-verdict" className="fit-verdict" />
          <figure className="fit-plan" aria-labelledby="fit-plan-caption">
            <div id="fit-plan-stage" className="fit-plan-stage">
              <div id="fit-plan-space" className="fit-plan-space">
                <span id="fit-plan-space-label" />
                <div id="fit-plan-piece" className="fit-plan-piece">
                  <span id="fit-plan-piece-label" />
                </div>
              </div>
            </div>
            <figcaption id="fit-plan-caption" className="fine-print">
              Plan view, drawn to scale: the piece against the space you measured.
            </figcaption>
          </figure>
          <div className="dimension-list">
            <p><span>Furniture width</span><b id="check-width">—</b></p>
            <p><span>Furniture depth</span><b id="check-depth">—</b></p>
            <p><span id="check-clearance-label">Measured clearance</span><b id="check-clearance">—</b></p>
          </div>
        </section>
      </div>

      <section className="conditions">
        <div>
          <span className="condition-icon">☀</span>
          <p><b>Bright room</b><br />300 lux or more helps floor tracking.</p>
        </div>
        <div>
          <span className="condition-icon">▧</span>
          <p><b>Textured floor</b><br />Avoid reflective or clear surfaces.</p>
        </div>
        <div>
          <span className="condition-icon">◉</span>
          <p><b>Steady connection</b><br />5 Mbps loads detailed 3D assets reliably.</p>
        </div>
      </section>

      {/* The engine shows messages here, exactly as before. */}
      <div id="toast" className="toast" role="status" aria-live="polite" />
    </div>
  );
}

export default function PlannerCards({ products }) {
  // useSearchParams needs a Suspense boundary to keep the route prerenderable.
  return (
    <Suspense fallback={<section className="planner-intro"><h1 id="planner-title">Your room, planned with confidence.</h1></section>}>
      <PlannerBody products={products} />
    </Suspense>
  );
}

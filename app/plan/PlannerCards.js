'use client';

import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';

/* Pulled in only when someone opens it. It carries the trigonometry, the
   photo-scaling maths and an SVG floor plan, none of which a visitor who
   never taps "Measure without AR" should have to download. */
const MeasureSurface = lazy(() => import('./MeasureSurface.js'));

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
  const [measuring, setMeasuring] = useState(false);
  const [adopted, setAdopted] = useState(null);

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
          Scan your room and get its length, width, height, floor area and volume.
          Then, if you want, stand a real piece of furniture in it and see whether it fits.
        </p>
      </section>

      {failed && (
        <p className="form-error" role="alert">
          The planner could not start on this device: {failed}
        </p>
      )}

      <div className="planner-layout">
        {/*
            Scanning comes first, and needs nothing chosen.

            The order used to be pick-a-product, then measure — so the first
            thing anybody saw was a shopping decision, and measuring your own
            room appeared to depend on having already made it. It does not:
            a room is a room. Somebody standing in their living room wanting
            to know how big it is can now do that on arrival, and choose
            furniture afterwards or not at all.
        */}
        <section className="planner-card measure-card" aria-labelledby="measure-title">
          <div className="card-heading">
            <span className="step-number">01</span>
            <div><p>Measure your space</p><h2 id="measure-title">Room scan</h2></div>
          </div>

          <div className="mode-switch" role="radiogroup" aria-label="What to measure">
            {/*
                Clearance is gone.

                It measured the gap across an opening, which is a different
                question from "how big is this room" — and being first, it
                made the scanner open on the narrowest thing it could do.
                The two modes left both answer what the planner is for.
            */}
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
              className="mode-option is-active"
              data-measure-mode="room"
              role="radio"
              aria-checked="true"
            >
              Whole room
            </button>
          </div>

          {/*
             Settings, rather than only the two-point mode.

             Both of these change a real calculation: the unit changes every
             figure the scan reports, and the walking space is fed to the fit
             verdict as room that must be left around a piece. There is
             deliberately nothing here that only looks like a setting.

             Note this survived the removal of the Clearance SCAN MODE: the
             figure is still used, as walking space. Only the two-point scan
             that measured a doorway is gone.
          */}
          <details className="scan-settings">
            <summary>
              <span aria-hidden="true">⚙</span> Scan settings
            </summary>
            <div className="scan-settings-body">
              <fieldset>
                <legend>Units</legend>
                <div className="unit-switch" role="radiogroup" aria-label="Units">
                  <button type="button" className="unit-option is-active" data-unit="m" role="radio" aria-checked="true">m</button>
                  <button type="button" className="unit-option" data-unit="cm" role="radio" aria-checked="false">cm</button>
                  <button type="button" className="unit-option" data-unit="mm" role="radio" aria-checked="false">mm</button>
                </div>
              </fieldset>
              <label className="setting-row">
                <span>Walking space to leave around furniture</span>
                <span className="setting-value">
                  <input
                    id="clearance-pref"
                    type="number"
                    min="0"
                    max="200"
                    step="5"
                    defaultValue={0}
                    inputMode="numeric"
                  />{' '}cm
                </span>
              </label>
            </div>
          </details>

          {/* The engine rewrites this per mode; the server-rendered text is
              the default mode's, so the page does not flash the wrong one. */}
          <p className="card-copy" id="measure-copy">
            Stand near the middle of the room and turn slowly through a half-circle.
            Floor and walls are detected as you go, and the room’s length, width and
            height are measured from them.
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

          {/*
             The way in for a phone with no ARCore.

             Offered beside the AR button rather than hidden behind a failure,
             because "your device is not supported" is the wrong first thing to
             show somebody standing in the room they want measured. The tilt
             and photo methods need no ARCore at all, and typing in tape
             figures is more accurate than either.
          */}
          <div className="no-ar-cta">
            <button type="button" className="button" onClick={() => setMeasuring(true)}>
              Measure without AR
            </button>
            <p className="ar-status">
              Works on any phone: aim at the floor and read the angle, scale from
              a photo, or type in tape-measure figures.
            </p>
          </div>
        </section>

        <section className="planner-card product-picker" aria-labelledby="picker-title">
          <div className="card-heading">
            <span className="step-number">02</span>
            <div>
              <p>Optional</p>
              <h2 id="picker-title">Place a piece in it</h2>
            </div>
          </div>
          <p className="card-copy">
            Skip this if you only wanted the measurements — they are yours either way.
          </p>
          <div id="planner-product" className="planner-product" />
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

      {/* The engine's own toast element used to live here. Its messages now
          go through lib/alerts/store.mjs and are drawn by the site's single
          AlertContainer, so there is one live region for them, not two. */}

      {measuring && (
        <Suspense fallback={<p className="ar-status">Opening the measuring tools…</p>}>
          <MeasureSurface
            onClose={() => setMeasuring(false)}
            onUseRoom={room => {
              /*
                 Handed to the engine through its own adoptRoom hook rather
                 than written into the DOM here. The engine owns the clearance
                 figure, the floor-area field and the fit verdict; setting the
                 text directly would leave those three disagreeing with the
                 room on screen.
              */
              const taken = window.__furnisharPlanner?.adoptRoom(room);
              setAdopted(taken ? room : null);
              setMeasuring(false);
              if (!taken) return;
              document.querySelector('.verdict-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }}
          />
        </Suspense>
      )}

      {adopted && (
        <p className="ar-status" role="status">
          Using a room measured without AR:{' '}
          {Math.max(adopted.length, adopted.width).toFixed(2)} ×{' '}
          {Math.min(adopted.length, adopted.width).toFixed(2)} m
          {adopted.height ? ` × ${adopted.height.toFixed(2)} m` : ''}.
        </p>
      )}
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

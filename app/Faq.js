/**
 * The questions people actually ask before they trust a measurement.
 *
 * Built on <details>/<summary> rather than a state hook and a div, which is
 * not a shortcut — it is the better component. It opens with no JavaScript, it
 * is keyboard-operable and announced as a disclosure without a single ARIA
 * attribute, and the browser's own find-in-page can open a closed answer. A
 * hand-rolled accordion gives up all four and gains nothing.
 *
 * Every answer here is checked against the code that implements it. An FAQ is
 * the easiest place in a site to promise something the software does not do,
 * and the hardest place for anyone to notice.
 */
const QUESTIONS = [
  {
    q: 'Do I need to install an app?',
    a: `No. FurnishAR runs in the browser. Live placement through the camera needs a
        phone with WebXR — Android Chrome on an ARCore device — and iPhones open the
        piece in Quick Look instead. Anywhere else you still get the catalogue, the
        real dimensions and the fit check.`
  },
  {
    q: 'How exact is the measurement?',
    a: `The planner measures the real surface your camera is looking at and reports
        the result in centimetres. It depends on light and on having a plain floor
        or wall to lock onto, so treat it as a confident check rather than a tape
        measure: for a piece that clears a doorway by a centimetre, measure twice.`
  },
  {
    q: 'What does it cost to shop here?',
    a: `Nothing. There is no account to make, no card, and no cart — FurnishAR shows
        you whether a piece fits and who sells it. You buy from the store itself.`
  },
  {
    q: 'How does my store get listed?',
    a: `Apply through the store portal. The application goes to the platform admin,
        who reviews it before anything of yours is public, and you can add products
        as soon as it is approved.`
  },
  {
    q: 'What 3D files can I upload?',
    a: `.glb. If yours is over the size limit the portal shrinks it in your browser
        before it uploads — textures first, then the geometry encoding — and tells
        you exactly what it changed. Files well past 50 MB come through this way.`
  },
  {
    q: 'What do you keep about me?',
    a: `Only store owners have accounts: an email address, the store's own details,
        and the products they publish. Shoppers are not asked for anything. Your
        theme choice and whether you dismissed the storage notice stay in your own
        browser and are never sent anywhere.`
  }
];

export default function Faq() {
  return (
    <section className="faq-section" id="faq" aria-labelledby="faq-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Before you measure</p>
          <h2 id="faq-title">Questions, answered plainly.</h2>
        </div>
      </div>

      <div className="faq-list">
        {QUESTIONS.map(({ q, a }) => (
          <details className="faq-item" key={q}>
            <summary>
              <span>{q}</span>
              {/* Decorative: the open/closed state is already announced by the
                  disclosure role, so this must not be read out a second time. */}
              <i aria-hidden="true" />
            </summary>
            <p>{a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

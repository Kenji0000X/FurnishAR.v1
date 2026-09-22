import Faq from '../Faq.js';

export const metadata = {
  title: 'Common questions',
  description:
    'What FurnishAR measures, what it needs from your phone, and what it costs a store to list.'
};

/**
 * The questions, on their own route.
 *
 * Previously the tail of the home page. "How exact is the measurement?" is the
 * question that decides whether somebody trusts the whole product, and it was
 * reachable only by scrolling past the entire catalogue to find it.
 */
export default function FaqPage() {
  return (
    <section className="view active">
      <section className="page-intro">
        <p className="eyebrow">Before you measure</p>
        <h1>Questions, answered plainly.</h1>
        <p>
          Every answer here is checked against the code that implements it. Where
          the software cannot do something, it says so.
        </p>
      </section>

      <Faq />
    </section>
  );
}

import { getCatalog } from '../../lib/catalog.mjs';
import PlannerCards from './PlannerCards.js';
import PlannerGate from './PlannerGate.js';

// The catalogue is a file the owner portal can write to, so pages are allowed
// to render again rather than being frozen at build time.
export const revalidate = 60;

export const metadata = {
  title: 'Space planner',
  description:
    'Scan a doorway or a floor area with your phone camera and check whether a piece of furniture fits, in centimetres.'
};

export default async function PlanPage() {
  // The catalogue is fetched on the server and handed to the engine, so the
  // planner no longer waits on a client-side round trip before it can show a
  // product.
  const { products } = await getCatalog();

  return (
    <section className="view planner-view active" aria-labelledby="planner-title">
      {/* The catalogue is still fetched and rendered on the server; the gate
          only decides whether the planner is handed over. Passing it as
          children keeps PlannerCards a server-rendered tree rather than
          making the whole planner wait on a client-side catalogue fetch. */}
      <PlannerGate>
        <PlannerCards products={products} />
      </PlannerGate>
    </section>
  );
}

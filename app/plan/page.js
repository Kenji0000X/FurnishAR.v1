import { getCatalog } from '../../lib/catalog.mjs';
import PlannerCards from './PlannerCards.js';

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
      <PlannerCards products={products} />
    </section>
  );
}

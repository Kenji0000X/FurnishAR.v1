import { getCatalog } from '../../lib/catalog.mjs';
import PlannerCards from './PlannerCards.js';

// The build machine has no Supabase credentials, so the first render of this
// page falls back to the bundled catalogue. Without a revalidate window that
// fallback would be baked in permanently and a shop's real products would
// never appear — the page must be allowed to render again once the deployment
// has its credentials. Sixty seconds is the same window lib/catalog.mjs uses
// for the query itself.
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

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getCatalog, getProduct, getStores } from '../../../lib/catalog.mjs';
import ProductViewer from './ProductViewer.js';
import { modelState, MODEL_STATE } from '../../model-state.js';
import ProductActions from './ProductActions.js';
import { peso, cm } from '../../format.js';

/**
 * One piece of furniture, at its own URL.
 *
 * This used to be a JS dialog over the catalogue, so a piece could not be
 * linked to, previewed in a chat app, or indexed. Everything below the actions
 * is server-rendered for exactly that reason.
 */

// Prebuilt product pages must be allowed to render again, so an edit made in
// the owner portal is not hidden behind a build-time snapshot.
export const revalidate = 60;

export async function generateStaticParams() {
  const { products } = await getCatalog();
  return products.map(product => ({ slug: product.slug || product.id }));
}

export async function generateMetadata({ params }) {
  const { slug } = await params;
  const product = await getProduct(slug);
  if (!product) return { title: 'Piece not found' };

  const size = `${product.dimensions.width} × ${product.dimensions.depth} × ${product.dimensions.height} cm`;
  return {
    title: product.name,
    description: product.description || `${product.name} from ${product.store}, ${size}.`,
    alternates: { canonical: `/furniture/${product.slug || product.id}` },
    openGraph: {
      title: `${product.name} · ${peso(product.price)}`,
      description: `${product.store} · ${size}`,
      type: 'website'
    }
  };
}

export default async function ProductPage({ params }) {
  const { slug } = await params;
  const [product, stores] = await Promise.all([getProduct(slug), getStores()]);
  if (!product) notFound();

  const store = stores[product.storeId];
  const state = modelState(product);
  const hasModel = state === MODEL_STATE.MODEL;
  const inStock = Number.isFinite(Number(product.stock)) ? Number(product.stock) : null;

  return (
    <article className="view active product-page">
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link href="/">Collection</Link>
        <span aria-hidden="true"> / </span>
        <Link href={`/?category=${encodeURIComponent(product.category)}#catalog`}>
          {product.category}
        </Link>
        <span aria-hidden="true"> / </span>
        <span aria-current="page">{product.name}</span>
      </nav>

      {/*
        Viewer left, facts right. The viewer takes the larger half because the
        whole point of this page is judging a physical object you cannot touch;
        a product reduced to a thumbnail beside a wall of specification is the
        layout of a parts catalogue, not a furniture one.
      */}
      <div className="product-detail">
        <div className="product-detail-viewer">
          <ProductViewer product={product} />
        </div>

        <div className="product-detail-info">
          <p className="product-store">{product.store}</p>
          <h1>{product.name}</h1>
          <p className="detail-price">{peso(product.price)}</p>

          {/* Stated, not implied by an absent badge. */}
          <p className={`detail-availability${hasModel ? ' is-ar' : ''}`}>
            {hasModel
              ? 'Can be placed in your room at true scale'
              : 'No 3D model — cannot be placed in AR yet'}
            {inStock !== null && (
              <>
                {' · '}
                {inStock > 0 ? `${inStock} in stock` : 'Out of stock'}
              </>
            )}
          </p>

          {product.description && <p className="detail-description">{product.description}</p>}

          <dl className="detail-specs">
            <div><dt>Size</dt><dd>{cm(product.dimensions.width)} × {cm(product.dimensions.depth)} × {cm(product.dimensions.height)}</dd></div>
            <div><dt>Category</dt><dd>{product.category}</dd></div>
            {product.style && <div><dt>Style</dt><dd>{product.style}</dd></div>}
            {product.color && <div><dt>Colour</dt><dd>{product.color}</dd></div>}
            <div>
              <dt>3D model</dt>
              <dd>{hasModel ? 'Uploaded by the shop' : 'Not provided'}</dd>
            </div>
          </dl>

          {/* Which AR button to show depends on the device, which the server
              cannot know — so only this part is a client component. */}
          <ProductActions product={product} />

          {store && (
            <section className="detail-store" aria-labelledby="store-heading">
              <h2 id="store-heading">Sold by {store.name}</h2>
              <dl className="store-card">
                <div><dt>Address</dt><dd>{store.address}</dd></div>
                <div><dt>Contact</dt><dd>{store.contactNumber}</dd></div>
                <div><dt>Hours</dt><dd>{store.hours}</dd></div>
              </dl>
            </section>
          )}
        </div>
      </div>
    </article>
  );
}

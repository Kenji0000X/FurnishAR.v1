import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getCatalog, getProduct, getStores } from '../../../lib/catalog.mjs';
import FurnitureIllustration from '../../FurnitureIllustration.js';
import ProductActions from './ProductActions.js';
import { peso, cm } from '../../format.js';

/**
 * One piece of furniture, at its own URL.
 *
 * This used to be a JS dialog over the catalogue, so a piece could not be
 * linked to, previewed in a chat app, or indexed. Everything below the actions
 * is server-rendered for exactly that reason.
 */

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

  return (
    <article className="view active product-page">
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link href="/">Collection</Link>
        <span aria-hidden="true"> / </span>
        <span aria-current="page">{product.name}</span>
      </nav>

      <div className="dialog-layout">
        <div className="dialog-image">
          <FurnitureIllustration product={product} />
        </div>

        <div className="dialog-info">
          <p className="product-store">{product.store} · {product.category}</p>
          <h1>{product.name}</h1>
          <p className="dialog-price">{peso(product.price)}</p>
          {product.description && <p>{product.description}</p>}

          <div className="dialog-dimensions">
            <div><span>WIDTH</span><b>{cm(product.dimensions.width)}</b></div>
            <div><span>DEPTH</span><b>{cm(product.dimensions.depth)}</b></div>
            <div><span>HEIGHT</span><b>{cm(product.dimensions.height)}</b></div>
          </div>

          {store && (
            <dl className="store-card">
              <div><dt>Store</dt><dd>{store.name}</dd></div>
              <div><dt>Address</dt><dd>{store.address}</dd></div>
              <div><dt>Contact</dt><dd>{store.contactNumber}</dd></div>
              <div><dt>Hours</dt><dd>{store.hours}</dd></div>
            </dl>
          )}

          {/* Which AR button to show depends on the device, which the server
              cannot know — so only this part is a client component. */}
          <ProductActions product={product} />
        </div>
      </div>
    </article>
  );
}

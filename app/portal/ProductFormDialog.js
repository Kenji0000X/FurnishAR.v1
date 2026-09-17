'use client';

import { useEffect, useRef, useState } from 'react';
import { usingSupabase, supabase, api } from './backend.js';

const CATEGORIES = ['Sofa', 'Table', 'Chair', 'Bed', 'Storage'];
const SHAPES = ['sofa', 'table', 'chair', 'bed', 'shelf', 'desk'];

/**
 * What an upload has to fit inside.
 *
 * Deliberately under Supabase's own ceiling rather than equal to it: a Free
 * project refuses anything over 50 MB no matter what the bucket says, and a
 * model that only just fits still costs every shopper that download on a
 * phone. 40 MB leaves headroom and is already far more than a well-made piece
 * of furniture needs.
 */
const UPLOAD_LIMIT_BYTES = 40 * 1024 * 1024;

/**
 * Add or edit a piece.
 *
 * Still a real <dialog>, so the browser handles the focus trap, Escape, and
 * the top layer for us — there is nothing React does better here.
 * `product` is null for a new piece.
 */
export default function ProductFormDialog({ product, session, onClose, onSaved }) {
  const dialogRef = useRef(null);
  // The row this dialog created, if a previous attempt got that far and then
  // failed on the upload. A ref, not state: it must survive a re-render
  // without causing one, and it is never read during render.
  const createdId = useRef(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');   // 'Saving…' | 'Uploading model… 42%'
  // Set when an oversized model was resized on the way through, so the owner
  // is told their file was changed rather than discovering it later.
  const [shrunkNote, setShrunkNote] = useState('');

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog?.open) dialog?.showModal();
    // Closing by Escape or the backdrop has to tell the parent too, or the
    // dialog cannot be reopened.
    const handleClose = () => onClose();
    dialog?.addEventListener('close', handleClose);
    return () => dialog?.removeEventListener('close', handleClose);
  }, [onClose]);

  const value = field => product?.[field] ?? '';
  const dimension = field => product?.dimensions?.[field] ?? '';
  const bounds = field => product?.modelBounds?.[field] ?? '';

  async function handleSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    const modelFile = form.elements.modelFile?.files?.[0] || null;
    setError('');
    setStatus('Saving…');

    const payload = {
      ...values,
      price: Number(values.price),
      stock: Number(values.stock),
      dimensions: {
        width: Number(values.width),
        height: Number(values.height),
        depth: Number(values.depth)
      },
      modelGlb: values.modelGlb ? String(values.modelGlb).trim() : undefined,
      modelUsdz: values.modelUsdz ? String(values.modelUsdz).trim() : undefined,
      modelBounds: {
        width: Number(values.modelWidth || values.width),
        height: Number(values.modelHeight || values.height),
        depth: Number(values.modelDepth || values.depth)
      }
    };

    try {
      if (usingSupabase()) {
        const storeUuid = session?.user?.storeUuid;
        if (!storeUuid) throw new Error('Your store is still awaiting approval.');
        // Saving is two steps — create the row, then upload the model — and
        // the second can fail on its own (a refused file, a dropped
        // connection). The row from the first attempt still exists, so a
        // straight retry used to insert it a second time and collide with
        // `unique (store_id, slug)`: PostgREST 409, reported as "you already
        // have a product with that name", about the product you had just
        // half-created yourself. Remembering the id turns the retry into the
        // update it should always have been.
        const saved = await supabase().saveProduct(
          { ...payload, id: values.id || createdId.current || undefined },
          storeUuid
        );
        if (!saved?.id) {
          // PATCH matching no row comes back as an empty array; reading .id off
          // that throws a TypeError that says nothing useful about the cause.
          throw new Error('The product could not be saved — it may have been deleted. Reload and try again.');
        }
        createdId.current = saved.id;
        if (modelFile) {
          // Shrink it first if it will not fit. Storage enforces a per-file
          // limit and a refusal at that point is the end of the road for
          // someone with no way to re-export — so the resizing happens here,
          // automatically, rather than being homework.
          setStatus('Checking model size…');
          const { compressGlb, formatBytes } = await import('./compress-model.js');
          const result = await compressGlb(modelFile, {
            maxBytes: UPLOAD_LIMIT_BYTES,
            onProgress: (stage, fraction) => setStatus(
              stage === 'reading'
                ? 'Reading model…'
                : `Shrinking model… ${Math.round(fraction * 100)}%`
            )
          });

          if (result.stillTooBig) {
            throw new Error(
              `This model is ${formatBytes(result.originalBytes)}. Compressing its geometry, `
              + `resizing its textures and reducing its detail got it to `
              + `${formatBytes(result.finalBytes)}, which is still over the `
              + `${formatBytes(UPLOAD_LIMIT_BYTES)} limit. It is likely several pieces exported `
              + 'together — export just this one, or reduce it in your 3D tool, and try again.'
            );
          }
          if (result.changed) {
            setShrunkNote(
              `Model shrunk from ${formatBytes(result.originalBytes)} to `
              + `${formatBytes(result.finalBytes)} so it fits and loads quickly for shoppers.`
              + (result.simplified
                ? ' Some fine detail was reduced to get it there; check it looks right in AR.'
                : ' Nothing was removed — the same model, stored more efficiently.')
            );
          }

          setStatus('Uploading model… 0%');
          await supabase().uploadModel(result.file, {
            storeUuid,
            productId: saved.id,
            kind: 'glb',
            // A big file on a slow connection can take minutes; a status line
            // that never changes in that time looks frozen, not working.
            onProgress: fraction => setStatus(`Uploading model… ${Math.round(fraction * 100)}%`)
          });
        }
      } else {
        if (modelFile) {
          throw new Error(
            'Model uploads need the Supabase backend. Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY.'
          );
        }
        await api(values.id ? `/api/products/${values.id}` : '/api/products', {
          method: values.id ? 'PUT' : 'POST',
          token: session?.token,
          body: JSON.stringify(payload)
        });
      }
      dialogRef.current?.close();
      onSaved(values.id ? 'Product updated.' : 'Product added to the catalog.');
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setStatus('');
    }
  }

  return (
    <dialog ref={dialogRef} className="form-dialog">
      <button
        className="dialog-close"
        type="button"
        aria-label="Close form"
        onClick={() => dialogRef.current?.close()}
      >
        ×
      </button>
      <h2>{product ? 'Edit product' : 'Add a product'}</h2>

      <form className="product-form" onSubmit={handleSubmit}>
        <input type="hidden" name="id" defaultValue={product?.id ?? ''} />

        <div className="form-grid">
          <label>Product name<input name="name" required maxLength={90} defaultValue={value('name')} /></label>
          <label>
            Category
            <select name="category" defaultValue={value('category') || 'Storage'}>
              {CATEGORIES.map(category => <option key={category}>{category}</option>)}
            </select>
          </label>
          <label>Style<input name="style" required defaultValue={value('style') || 'Modern'} /></label>
          <label>Colour<input name="color" required defaultValue={value('color') || 'Natural'} /></label>
          <label>Price (PHP)<input name="price" type="number" min="0" step="1" required defaultValue={value('price')} /></label>
          <label>In stock<input name="stock" type="number" min="0" step="1" required defaultValue={value('stock')} /></label>
          <label>Width (cm)<input name="width" type="number" min="1" required defaultValue={dimension('width')} /></label>
          <label>Height (cm)<input name="height" type="number" min="1" required defaultValue={dimension('height')} /></label>
          <label>Depth (cm)<input name="depth" type="number" min="1" required defaultValue={dimension('depth')} /></label>
          <label>
            Preview shape
            <select name="model" defaultValue={value('model') || 'shelf'}>
              {SHAPES.map(shape => (
                <option key={shape} value={shape}>
                  {shape[0].toUpperCase() + shape.slice(1)}
                </option>
              ))}
            </select>
          </label>
          <label className="form-wide">
            3D model (.glb)
            <input name="modelFile" type="file" accept=".glb,model/gltf-binary" />
            <small className="field-note">
              Uploaded to your store&apos;s folder. Up to 50 MB. Leave empty to keep the current model.
            </small>
          </label>
          <label>Android GLB path<input name="modelGlb" type="text" placeholder="models/example.glb" defaultValue={value('modelGlb')} /></label>
          <label>iPhone USDZ path<input name="modelUsdz" type="text" placeholder="models/example.usdz" defaultValue={value('modelUsdz')} /></label>
          <label>AR box width (cm)<input name="modelWidth" type="number" min="1" step="0.1" placeholder="same as width" defaultValue={bounds('width')} /></label>
          <label>AR box height (cm)<input name="modelHeight" type="number" min="1" step="0.1" placeholder="same as height" defaultValue={bounds('height')} /></label>
          <label>AR box depth (cm)<input name="modelDepth" type="number" min="1" step="0.1" placeholder="same as depth" defaultValue={bounds('depth')} /></label>
        </div>

        <label>
          Description
          <textarea name="description" rows={3} maxLength={400} defaultValue={value('description')} />
        </label>

        {shrunkNote && <p className="form-note" role="status">{shrunkNote}</p>}
        <p className="form-error" role="alert" aria-live="assertive">{error}</p>
        <button className="button button-primary" type="submit" disabled={Boolean(status)}>
          {status || 'Save product'}
        </button>
      </form>
    </dialog>
  );
}

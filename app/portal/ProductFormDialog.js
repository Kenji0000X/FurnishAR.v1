'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Cube, UploadSimple, WarningCircle } from '@phosphor-icons/react/dist/ssr';
import { usingSupabase, supabase, api } from './backend.js';
import ModelPreview, { dimensionsKey, modelSourceKey } from './ModelPreview.js';
import { SCALE_STATUS } from '../../lib/spatial/model-scale.mjs';
import {
  FURNITURE_UNITS, CANONICAL_UNIT, toCentimeters, inputValue, roundForStorage,
  dimensionProblem, isUnusuallyLarge, formatDimensions, formatLength, isFurnitureUnit,
  DIMENSION_WARNING_CM
} from '../../lib/spatial/units.mjs';
import { MODEL_UPLOAD_LIMIT_BYTES, MODEL_UPLOAD_LIMIT_LABEL } from '../../public/model-limits.mjs';

const CATEGORIES = ['Sofa', 'Table', 'Chair', 'Bed', 'Storage'];

/**
 * The three sides, in the order the owner measures and the AR readout lists
 * them: width (X), depth (Z), height (Y).
 */
const AXES = [
  { key: 'width', label: 'Width', hint: 'side to side' },
  { key: 'depth', label: 'Depth', hint: 'front to back' },
  { key: 'height', label: 'Height', hint: 'floor to top' }
];

/**
 * Where a chosen model is on its way to being saved. One value at a time, so
 * the surface never says "ready" and "uploading" at once. Every state is
 * reached by something that actually happened, never by a timer.
 */
export const UPLOAD_STATE = Object.freeze({
  EMPTY: 'empty',
  FILE_SELECTED: 'file-selected',
  PARSING: 'parsing',
  VALIDATING_GEOMETRY: 'validating-geometry',
  VALIDATING_SCALE: 'validating-scale',
  READY: 'ready',
  COMPRESSING: 'compressing',
  UPLOADING: 'uploading',
  SAVING: 'saving',
  SUCCESS: 'success',
  ERROR: 'error',
  SCALE_MISMATCH: 'scale-mismatch'
});

const PREVIEW_PHASE_TO_STATE = {
  parsing: UPLOAD_STATE.PARSING,
  'validating-geometry': UPLOAD_STATE.VALIDATING_GEOMETRY,
  'validating-scale': UPLOAD_STATE.VALIDATING_SCALE
};

/** How long a save waits for a model that is still being read. */
const CHECK_WAIT_MS = 90_000;

const UNIT_STORAGE_KEY = 'furnishar:portal-unit';

function rememberedUnit() {
  try {
    const unit = window.localStorage.getItem(UNIT_STORAGE_KEY);
    return isFurnitureUnit(unit) ? unit : CANONICAL_UNIT;
  } catch {
    return CANONICAL_UNIT;
  }
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/**
 * Add or edit a piece.
 *
 * Still a real <dialog>, so the browser handles the focus trap, Escape, the
 * top layer and giving focus back to whatever opened it.
 * `product` is null for a new piece.
 *
 * The 3D part follows the owner's actual task, in order:
 *
 *   PHYSICAL SIZE → UPLOAD MODEL → VALIDATE → PREVIEW → READY FOR AR → SAVE
 *
 * The size typed here is THE size of the furniture. The model file supplies
 * the shape; it is scaled, uniformly, to this size, and refused if its shape
 * cannot be this size without stretching. There used to be a second set of
 * width/height/depth fields ("AR box size") that could disagree with the
 * first; there is now one physical size, stored in centimetres.
 */
export default function ProductFormDialog({ product, session, onClose, onSaved }) {
  const dialogRef = useRef(null);
  const headingRef = useRef(null);
  const fileInputRef = useRef(null);
  const sizeInputRefs = useRef({});
  // The row this dialog created, if a previous attempt got that far and then
  // failed on the upload. A ref, not state: it must survive a re-render
  // without causing one, and it is never read during render.
  const createdId = useRef(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');   // 'Saving…' | 'Uploading model… 42%'
  const [saveStage, setSaveStage] = useState(null); // COMPRESSING | UPLOADING | SAVING | SUCCESS
  // Set when an oversized model was resized on the way through, so the owner
  // is told their file was changed rather than discovering it later.
  const [shrunkNote, setShrunkNote] = useState('');

  /* ---------------------------------------------------- physical size -- */

  const initialCm = product?.dimensions || null;
  const [unit, setUnit] = useState(CANONICAL_UNIT);
  // What each field says, and what it means in centimetres. The centimetres
  // are the truth; the text is only how they are written in the chosen unit.
  const [sizeText, setSizeText] = useState(() => Object.fromEntries(AXES.map(({ key }) => [
    key, Number.isFinite(Number(initialCm?.[key])) && initialCm?.[key] !== '' && initialCm?.[key] != null
      ? inputValue(Number(initialCm[key]), CANONICAL_UNIT) : ''
  ])));
  const [sizeCm, setSizeCm] = useState(() => Object.fromEntries(AXES.map(({ key }) => [
    key, Number(initialCm?.[key]) > 0 ? Number(initialCm[key]) : null
  ])));
  const [sizeTouched, setSizeTouched] = useState({});
  const [showSizeErrors, setShowSizeErrors] = useState(false);

  // The owner's unit is remembered on this browser only: a convenience, not
  // data. The stored size is centimetres whichever unit they type in.
  useEffect(() => {
    const remembered = rememberedUnit();
    if (remembered !== CANONICAL_UNIT) changeUnit(remembered);
    // Runs once, on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sizeErrors = Object.fromEntries(AXES.map(({ key, label }) => [
    key, dimensionProblem(sizeText[key], unit, label)
  ]));
  const storedCm = AXES.every(({ key }) => !sizeErrors[key] && sizeCm[key] > 0)
    ? Object.fromEntries(AXES.map(({ key }) => [key, roundForStorage(sizeCm[key])]))
    : null;
  // A stable object for the preview, so it only re-sizes when a number changes.
  const storedKey = dimensionsKey(storedCm);
  const dimensionsCm = useMemo(() => storedCm, [storedKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const largeAxes = storedCm ? AXES.filter(({ key }) => isUnusuallyLarge(storedCm[key])) : [];

  function editSize(key, text) {
    setSizeText(current => ({ ...current, [key]: text }));
    const problem = dimensionProblem(text, unit, key);
    setSizeCm(current => ({ ...current, [key]: problem ? null : toCentimeters(Number(text), unit) }));
  }

  function changeUnit(next) {
    if (!isFurnitureUnit(next)) return;
    // Rewrite each valid field from its centimetres, so switching back and
    // forth never rounds the size away. A field that is empty or wrong is
    // left as typed: there is no length in it to convert.
    setUnit(next);
    setSizeText(current => {
      const updated = { ...current };
      for (const { key } of AXES) {
        if (sizeCm[key] > 0) updated[key] = inputValue(sizeCm[key], next);
      }
      return updated;
    });
    try { window.localStorage.setItem(UNIT_STORAGE_KEY, next); } catch { /* private window: fine */ }
  }

  const visibleSizeError = key => (showSizeErrors || sizeTouched[key]) ? sizeErrors[key] : null;

  /* -------------------------------------------------------- the model -- */

  const existingPath = product?.modelGlb || '';
  const [advancedPath, setAdvancedPath] = useState(existingPath);
  const [pendingFile, setPendingFile] = useState(null);
  const [fileProblem, setFileProblem] = useState('');
  const [dragging, setDragging] = useState(false);
  const [check, setCheck] = useState({ phase: 'empty' });
  const checkRef = useRef(check);
  const waiters = useRef([]);

  // What the preview is showing: a newly chosen file, or the model already
  // stored for this product. Demo mode can also point at a path by hand.
  const storedPath = usingSupabase() ? existingPath : advancedPath;
  const source = useMemo(
    () => (pendingFile ? { file: pendingFile } : storedPath ? { path: storedPath } : null),
    [pendingFile, storedPath]
  );
  const sourceKey = modelSourceKey(source);

  const handleResult = useCallback(outcome => {
    checkRef.current = outcome;
    setCheck(outcome);
    if (outcome.phase === 'checked' || outcome.phase === 'error' || outcome.phase === 'empty') {
      const still = [];
      for (const waiter of waiters.current) (waiter(outcome) ? null : still.push(waiter));
      waiters.current = still;
    }
  }, []);

  /**
   * The finished check for exactly this file at exactly this size. A save
   * that arrives while the model is still being read waits for it rather than
   * refusing; the owner should not have to watch a spinner before pressing
   * Save.
   */
  function settledCheck(wantSource, wantDims) {
    const matches = outcome => outcome.sourceKey === wantSource && outcome.dimsKey === wantDims
      && (outcome.phase === 'checked' || outcome.phase === 'error');
    if (matches(checkRef.current)) return Promise.resolve(checkRef.current);
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve(null), CHECK_WAIT_MS);
      waiters.current.push(outcome => {
        if (!matches(outcome)) return false;
        clearTimeout(timer);
        resolve(outcome);
        return true;
      });
    });
  }

  function chooseFile(file) {
    setFileProblem('');
    setShrunkNote('');
    setError('');
    if (!file) return;
    if (!/\.glb$/i.test(file.name)) {
      setFileProblem(`${file.name} is not a .glb file. Export the model as glTF Binary (.glb) and choose that.`);
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    setPendingFile(file);
  }

  function removeFile() {
    setPendingFile(null);
    setFileProblem('');
    setShrunkNote('');
    if (fileInputRef.current) fileInputRef.current.value = '';
    fileInputRef.current?.focus();
  }

  function onDrop(event) {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    // Put the dropped file in the real input too, so the form, assistive
    // technology and the file picker all agree about what is chosen.
    try {
      const transfer = new DataTransfer();
      transfer.items.add(file);
      if (fileInputRef.current) fileInputRef.current.files = transfer.files;
    } catch { /* older Safari: the state below is what the form uses */ }
    chooseFile(file);
  }

  const reviewDimensions = useCallback(() => {
    const first = sizeInputRefs.current.width;
    first?.scrollIntoView?.({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    first?.focus({ preventScroll: true });
    first?.select?.();
  }, []);
  const replaceModel = useCallback(() => fileInputRef.current?.click(), []);

  const checkIsCurrent = check.sourceKey === sourceKey && check.dimsKey === storedKey;
  const mismatch = checkIsCurrent && check.phase === 'checked'
    && (check.status === SCALE_STATUS.PROPORTION_MISMATCH || check.status === SCALE_STATUS.BOUNDS_MISMATCH);

  // The one state the upload surface is in.
  let uploadState;
  if (saveStage) uploadState = saveStage;
  else if (!pendingFile) uploadState = fileProblem ? UPLOAD_STATE.ERROR : UPLOAD_STATE.EMPTY;
  else if (!checkIsCurrent && check.sourceKey !== sourceKey) uploadState = UPLOAD_STATE.FILE_SELECTED;
  else if (check.phase === 'error') uploadState = UPLOAD_STATE.ERROR;
  else if (PREVIEW_PHASE_TO_STATE[check.phase]) uploadState = PREVIEW_PHASE_TO_STATE[check.phase];
  else if (check.phase === 'checked' && !checkIsCurrent) uploadState = UPLOAD_STATE.VALIDATING_SCALE;
  else if (mismatch) uploadState = UPLOAD_STATE.SCALE_MISMATCH;
  else if (check.phase === 'checked' && check.verified) uploadState = UPLOAD_STATE.READY;
  else if (check.phase === 'checked' && check.status === SCALE_STATUS.NO_DIMENSIONS) uploadState = UPLOAD_STATE.FILE_SELECTED;
  else uploadState = UPLOAD_STATE.VALIDATING_SCALE;

  const stateLine = {
    [UPLOAD_STATE.EMPTY]: existingPath ? 'Current model kept. Choose a file to replace it.' : 'No model yet. The product can be saved without one.',
    [UPLOAD_STATE.FILE_SELECTED]: storedCm ? 'Model chosen.' : 'Model chosen. Enter the physical size to check it.',
    [UPLOAD_STATE.PARSING]: 'Reading the model…',
    [UPLOAD_STATE.VALIDATING_GEOMETRY]: 'Checking the geometry…',
    [UPLOAD_STATE.VALIDATING_SCALE]: 'Checking proportions against the physical size…',
    [UPLOAD_STATE.READY]: 'Ready for AR. It uploads when you save.',
    [UPLOAD_STATE.SCALE_MISMATCH]: 'Proportions don’t match the physical size.',
    [UPLOAD_STATE.ERROR]: fileProblem || 'This file could not be used.',
    [UPLOAD_STATE.COMPRESSING]: 'Compressing to fit…',
    [UPLOAD_STATE.UPLOADING]: 'Uploading…',
    [UPLOAD_STATE.SAVING]: 'Saving…',
    [UPLOAD_STATE.SUCCESS]: 'Saved.'
  }[uploadState];

  /* ------------------------------------------------------------ dialog -- */

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog?.open) dialog?.showModal();
    // The heading, not the close button, is where a screen reader should
    // start: it says what this dialog is.
    headingRef.current?.focus({ preventScroll: true });
    // Closing by Escape or the backdrop has to tell the parent too, or the
    // dialog cannot be reopened.
    const handleClose = () => onClose();
    dialog?.addEventListener('close', handleClose);
    return () => dialog?.removeEventListener('close', handleClose);
  }, [onClose]);

  const value = field => product?.[field] ?? '';

  async function handleSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    const modelFile = pendingFile;
    setError('');

    // The size first: nothing below means anything without it.
    if (!storedCm) {
      setShowSizeErrors(true);
      const firstBad = AXES.find(({ key }) => sizeErrors[key]);
      if (firstBad) sizeInputRefs.current[firstBad.key]?.focus();
      setError('Enter the furniture’s width, depth and height.');
      return;
    }

    if (modelFile) {
      setStatus('Checking model…');
      const outcome = await settledCheck(modelSourceKey({ file: modelFile }), dimensionsKey(storedCm));
      if (!outcome) {
        setStatus('');
        setError('The model is taking too long to read. Try again, or choose a smaller file.');
        return;
      }
      if (outcome.phase === 'error') {
        setStatus('');
        setError('This model file could not be read. Choose another file, or remove it to save without a model.');
        return;
      }
      if (!outcome.verified) {
        setStatus('');
        setError('The model’s proportions don’t match the physical size. Review the dimensions or replace the model.');
        return;
      }
    }

    setStatus('Saving…');
    setSaveStage(UPLOAD_STATE.SAVING);

    // One physical size, in centimetres. `modelBounds` is no longer sent: the
    // bounds_* columns are left null and the catalogue falls back to these
    // dimensions (see lib/catalog.mjs), so the two can never disagree again.
    const payload = {
      id: values.id,
      name: values.name,
      category: values.category,
      style: values.style,
      color: values.color,
      description: values.description,
      price: Number(values.price),
      stock: Number(values.stock),
      dimensions: { width: storedCm.width, height: storedCm.height, depth: storedCm.depth },
      modelGlb: !usingSupabase() && values.modelGlb ? String(values.modelGlb).trim() : undefined,
      modelUsdz: !usingSupabase() && values.modelUsdz ? String(values.modelUsdz).trim() : undefined
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
          // automatically, rather than being homework. Compression changes
          // how the model is stored, never its size: the scale is derived
          // from the dimensions above every time it is shown.
          setSaveStage(UPLOAD_STATE.COMPRESSING);
          setStatus('Checking model size…');
          const { compressGlb, formatBytes: format } = await import('./compress-model.js');
          const result = await compressGlb(modelFile, {
            maxBytes: MODEL_UPLOAD_LIMIT_BYTES,
            onProgress: (stage, fraction) => setStatus(
              stage === 'reading'
                ? 'Reading model…'
                : `Shrinking model… ${Math.round(fraction * 100)}%`
            )
          });

          if (result.stillTooBig) {
            throw new Error(
              `This model is ${format(result.originalBytes)}. Compressing its geometry, `
              + `resizing its textures and reducing its detail got it to `
              + `${format(result.finalBytes)}, which is still over the `
              + `${MODEL_UPLOAD_LIMIT_LABEL} limit. It is likely several pieces exported `
              + 'together — export just this one, or reduce it in your 3D tool, and try again.'
            );
          }
          if (result.changed) {
            // How it got there matters to the owner: "stored more efficiently"
            // and "a twentieth of its triangles" are very different pieces of
            // news about the thing customers are about to look at.
            const cost = !result.simplified
              ? ' Nothing was removed — the same model, stored more efficiently.'
              : result.simplifyRatio <= 0.25
                ? ` It needed heavy reduction to fit — about ${Math.round(result.simplifyRatio * 100)}%`
                  + ' of the original detail is left. Check it still looks right in AR before you publish it.'
                : ' Some fine detail was reduced to get it there; check it looks right in AR.';
            setShrunkNote(
              `Model shrunk from ${format(result.originalBytes)} to `
              + `${format(result.finalBytes)} so it fits and loads quickly for shoppers.${cost}`
            );
          }

          setSaveStage(UPLOAD_STATE.UPLOADING);
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
      setSaveStage(UPLOAD_STATE.SUCCESS);
      dialogRef.current?.close();
      onSaved(values.id ? 'Product updated.' : 'Product added to the catalog.');
    } catch (saveError) {
      setSaveStage(null);
      setError(saveError.message);
    } finally {
      setStatus('');
    }
  }

  const busy = Boolean(status);
  const existingMismatch = !pendingFile && mismatch;

  return (
    <dialog ref={dialogRef} className="form-dialog product-dialog" aria-labelledby="product-form-title">
      <button
        className="dialog-close"
        type="button"
        aria-label="Close form"
        onClick={() => dialogRef.current?.close()}
      >
        ×
      </button>
      {/* On a phone this bar pins to the top of a full-screen sheet, so
          Cancel is always one tap away however far down the form you are;
          Save is pinned to the bottom the same way. */}
      <header className="product-dialog-head">
        <button className="dialog-cancel" type="button" onClick={() => dialogRef.current?.close()}>Cancel</button>
        <div>
          <p className="product-dialog-eyebrow">{product ? 'Catalog · edit' : 'Catalog · new piece'}</p>
          <h2 id="product-form-title" ref={headingRef} tabIndex={-1}>{product ? 'Edit product' : 'Add a product'}</h2>
        </div>
      </header>

      <form className="product-form" onSubmit={handleSubmit}>
        <input type="hidden" name="id" defaultValue={product?.id ?? ''} />

        <div className="product-form-layout">
          <div className="product-form-main">
            <fieldset className="form-section">
              <legend>Basics</legend>
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
              </div>
            </fieldset>

            {/* 1 · Physical size. The number every other step is checked against. */}
            <fieldset className="form-section size-section" aria-describedby="size-help">
              <legend><span className="step-index" aria-hidden="true">1</span>Physical size</legend>
              <div className="size-head">
                <p id="size-help" className="field-note">
                  These measurements determine how large the furniture appears in AR.
                </p>
                <div className="unit-switch" role="radiogroup" aria-label="Measurement unit">
                  {FURNITURE_UNITS.map(option => (
                    <label key={option.id} className="unit-option">
                      <input
                        type="radio"
                        name="sizeUnit"
                        value={option.id}
                        checked={unit === option.id}
                        onChange={() => changeUnit(option.id)}
                      />
                      <span aria-hidden="true">{option.short}</span>
                      <span className="sr-only">{option.label}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="size-grid">
                {AXES.map(({ key, label, hint }) => {
                  const problem = visibleSizeError(key);
                  return (
                    <label key={key} className="size-field" data-invalid={problem ? 'true' : undefined}>
                      <span className="size-label">{label} <span className="size-hint">{hint}</span></span>
                      <span className="size-input">
                        <input
                          ref={node => { sizeInputRefs.current[key] = node; }}
                          name={key}
                          type="text"
                          inputMode="decimal"
                          autoComplete="off"
                          spellCheck={false}
                          value={sizeText[key]}
                          onChange={event => editSize(key, event.target.value)}
                          onBlur={() => setSizeTouched(current => ({ ...current, [key]: true }))}
                          aria-invalid={problem ? 'true' : undefined}
                          aria-describedby={problem ? `size-error-${key}` : 'size-help'}
                        />
                        <span className="size-unit" aria-hidden="true">{unit}</span>
                      </span>
                      {problem && <small id={`size-error-${key}`} className="field-error">{problem}</small>}
                    </label>
                  );
                })}
              </div>

              {storedCm && unit !== CANONICAL_UNIT && (
                <p className="field-note size-saved">Saved as {formatDimensions(storedCm, 'cm')}</p>
              )}
              {largeAxes.length > 0 && (
                <p className="field-note size-large" role="status">
                  {largeAxes.map(axis => axis.label).join(' and ')} {largeAxes.length > 1 ? 'are' : 'is'} over
                  {' '}{formatLength(DIMENSION_WARNING_CM, unit)}. Check the unit is right before you save.
                </p>
              )}
            </fieldset>

            {/* 2 · The model file. A real file input, dressed as a drop zone. */}
            <fieldset className="form-section model-section">
              <legend><span className="step-index" aria-hidden="true">2</span>3D model</legend>

              <div
                className="dropzone"
                data-dragging={dragging ? 'true' : undefined}
                data-state={uploadState}
                onDragOver={event => { event.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
              >
                <label className="dropzone-target">
                  <input
                    ref={fileInputRef}
                    className="dropzone-input"
                    name="modelFile"
                    type="file"
                    accept=".glb,model/gltf-binary"
                    aria-describedby="model-file-help model-file-state"
                    onChange={event => chooseFile(event.target.files?.[0] || null)}
                    disabled={busy}
                  />
                  <UploadSimple size={22} weight="light" aria-hidden="true" />
                  <span className="dropzone-title">
                    {pendingFile ? 'Choose a different file' : existingPath ? 'Replace the model' : 'Choose a .glb file'}
                  </span>
                  <span className="dropzone-sub">or drop it here</span>
                </label>
                <p id="model-file-help" className="field-note">
                  glTF Binary (.glb), up to {MODEL_UPLOAD_LIMIT_LABEL}. Larger files are compressed to fit when you save.
                  It&apos;s checked here before anything uploads.
                </p>
              </div>

              {pendingFile && (
                <div className="file-card">
                  <Cube size={20} weight="light" aria-hidden="true" />
                  <div className="file-card-text">
                    <span className="file-card-name" title={pendingFile.name}>{pendingFile.name}</span>
                    <span className="file-card-meta">
                      {formatBytes(pendingFile.size)}
                      {pendingFile.size > MODEL_UPLOAD_LIMIT_BYTES ? ` · over ${MODEL_UPLOAD_LIMIT_LABEL}, will be compressed` : ''}
                    </span>
                  </div>
                  <div className="file-card-actions">
                    <button type="button" className="text-button" onClick={replaceModel} disabled={busy}>Replace</button>
                    <button type="button" className="text-button" onClick={removeFile} disabled={busy}>
                      Remove<span className="sr-only"> {pendingFile.name}</span>
                    </button>
                  </div>
                </div>
              )}

              <p id="model-file-state" className="upload-state" data-state={uploadState} role="status">
                {[UPLOAD_STATE.PARSING, UPLOAD_STATE.VALIDATING_GEOMETRY, UPLOAD_STATE.VALIDATING_SCALE,
                  UPLOAD_STATE.COMPRESSING, UPLOAD_STATE.UPLOADING, UPLOAD_STATE.SAVING].includes(uploadState)
                  && <span className="loading-spinner" aria-hidden="true" />}
                {(uploadState === UPLOAD_STATE.ERROR || uploadState === UPLOAD_STATE.SCALE_MISMATCH)
                  && <WarningCircle size={14} weight="bold" aria-hidden="true" />}
                <span>{stateLine}</span>
              </p>

              {!usingSupabase() && (
                <details className="advanced-paths">
                  <summary>Advanced: model paths</summary>
                  <p className="field-note">
                    Demo catalogue only. Points the product at a model already in this site&apos;s files.
                  </p>
                  <div className="form-grid">
                    <label>Android GLB path<input name="modelGlb" type="text" placeholder="models/example.glb" value={advancedPath} onChange={event => setAdvancedPath(event.target.value.trim())} /></label>
                    <label>iPhone USDZ path<input name="modelUsdz" type="text" placeholder="models/example.usdz" defaultValue={value('modelUsdz')} /></label>
                  </div>
                </details>
              )}
            </fieldset>
          </div>

          {/* 3 · Preview and readiness, beside the steps on a wide screen and
              right after them on a phone. */}
          <aside className="product-form-preview" aria-labelledby="preview-title">
            <h3 id="preview-title" className="preview-title">
              <span className="step-index" aria-hidden="true">3</span>Preview at real size
            </h3>
            <ModelPreview
              source={source}
              dimensionsCm={dimensionsCm}
              unit={unit}
              existing={!pendingFile}
              onResult={handleResult}
              onReviewDimensions={reviewDimensions}
              onReplaceModel={replaceModel}
            />
          </aside>

          <div className="product-form-rest">
            <label>
              Description
              <textarea name="description" rows={3} maxLength={400} defaultValue={value('description')} />
            </label>
          </div>
        </div>

        <footer className="product-form-footer">
          <div className="product-form-messages">
            {existingMismatch && (
              <p className="form-note">
                You can save these changes, but shoppers won&apos;t see this model in AR until its proportions match.
              </p>
            )}
            {shrunkNote && <p className="form-note" role="status">{shrunkNote}</p>}
            <p className="form-error" role="alert" aria-live="assertive">{error}</p>
          </div>
          <button className="button button-primary" type="submit" disabled={busy} aria-busy={busy || undefined}>
            {status || 'Save product'}
          </button>
        </footer>
      </form>
    </dialog>
  );
}

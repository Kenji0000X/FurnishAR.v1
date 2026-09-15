// Presentation helpers shared by the server-rendered pages and the client
// components. Moved from public/client.js unchanged so prices and dimensions
// read identically to the site they replace.

export const peso = value =>
  new Intl.NumberFormat('en-PH', {
    style: 'currency',
    currency: 'PHP',
    maximumFractionDigits: 0
  }).format(value);

export const cm = value => `${Math.round(value)} cm`;

export const COLOR_STYLES = {
  Sand: '#d4b18b',
  Oak: '#aa7953',
  Terracotta: '#c46e50',
  Walnut: '#725343',
  Black: '#474b47',
  White: '#d9d4ca',
  Natural: '#b58d62'
};

export const colorFor = product => COLOR_STYLES[product.color] || '#8c9d88';

export const PREVIEW_SHAPES = ['sofa', 'table', 'chair', 'bed', 'shelf', 'desk'];

/** The CSS-drawn stand-in shown before a real model loads. */
export function previewShape(product) {
  return PREVIEW_SHAPES.includes(product.model) ? product.model : 'shelf';
}

/** `70 × 78 × 88 cm` — width × depth × height, the order shoppers read. */
export const dimensionLabel = ({ width, depth, height }) =>
  `${width} × ${depth} × ${height} cm`;

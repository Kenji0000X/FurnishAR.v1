/**
 * Three promises, as an asymmetric trio rather than a list.
 *
 * One large cell and two stacked, so the claims read in order of weight: the
 * first is the whole product ("real sizes"), and it carries the one real
 * picture on the page besides the room, the render of an actual listed
 * piece with the dimensions its shop measured. The other two are told apart
 * by surface, the deep band and the accent tint, not by icons.
 *
 * Each cell is a nested frame (an outer shell and an inner core with its own
 * radius), which is what makes them read as objects on the page rather than
 * boxes drawn around text.
 */
export default function Promises({ items, showcase }) {
  const [size, browser, local] = items;
  const dims = showcase?.dimensions;
  return (
    <div className="promise-grid">
      <article className="bezel promise promise-size reveal">
        <div className="bezel-core">
          {showcase?.thumbnail && (
            <figure className="promise-figure">
              <img src={showcase.thumbnail} alt={showcase.name} width="480" height="480" loading="lazy" decoding="async" />
              {dims && (
                <figcaption>
                  {showcase.name}: {dims.width} × {dims.depth} × {dims.height} cm
                </figcaption>
              )}
            </figure>
          )}
          <h3>{size.title}</h3>
          <p>{size.body}</p>
        </div>
      </article>
      <article className="bezel promise promise-browser reveal">
        <div className="bezel-core">
          <h3>{browser.title}</h3>
          <p>{browser.body}</p>
        </div>
      </article>
      <article className="bezel promise promise-local reveal">
        <div className="bezel-core">
          <h3>{local.title}</h3>
          <p>{local.body}</p>
        </div>
      </article>
    </div>
  );
}

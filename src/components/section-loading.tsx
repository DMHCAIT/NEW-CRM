export function SectionLoading({ title = "Workspace" }: { title?: string }) {
  return <section className="section-loading" aria-busy="true" aria-label={`${title} loading`}>
    <div className="page-heading"><h1>{title}</h1></div>
    <p role="status" aria-live="polite">Opening {title.toLowerCase()}...</p>
    <div className="panel section-loading-panel" aria-hidden="true">
      <div className="section-loading-toolbar"><span /><span /></div>
      {Array.from({ length: 6 }, (_, index) => <div className="section-loading-row" key={index}><span /><span /><span /></div>)}
    </div>
  </section>;
}

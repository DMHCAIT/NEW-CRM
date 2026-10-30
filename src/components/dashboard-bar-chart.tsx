import Link from "next/link";

export type DashboardChartCategory = {
  label: string;
  href: string;
  detail?: string;
  segments: { label: string; value: number; color: string; href: string }[];
};

type Props = {
  label: string;
  categories: DashboardChartCategory[];
  percent?: boolean;
  emptyMessage: string;
  legend?: { label: string; color: string; href: string }[];
};

export function DashboardBarChart({ label, categories, percent = false, emptyMessage, legend = [] }: Props) {
  const width = Math.max(320, categories.length * 112 + 70);
  const top = 32;
  const baseline = 232;
  const plotHeight = baseline - top;
  const totals = categories.map(category => category.segments.reduce((sum, segment) => sum + segment.value, 0));
  const maximum = percent ? 100 : Math.max(4, Math.ceil(Math.max(0, ...totals) / 4) * 4);
  const slot = (width - 70) / Math.max(1, categories.length);
  const barWidth = Math.min(54, slot * .55);
  const ticks = Array.from({ length: 5 }, (_, index) => maximum * index / 4);
  return <div className="dashboard-plot" role="group" aria-label={label}>
    <div className="dashboard-plot-scroll" tabIndex={0} role="region" aria-label={`${label} chart; scroll for more categories`}>
      <svg className="dashboard-plot-svg" width={width} height={312} style={{ minWidth: width }} viewBox={`0 0 ${width} 312`} aria-label={label}>
        <text x={48} y={16} className="dashboard-axis-caption">{percent ? "Conversion rate (%)" : "Number of leads"}</text>
        {ticks.map(tick => {
          const y = baseline - tick / maximum * plotHeight;
          return <g key={tick}><line x1={48} y1={y} x2={width - 12} y2={y} className="dashboard-gridline" /><text x={39} y={y + 4} textAnchor="end" className="dashboard-axis-label">{`${tick}${percent ? "%" : ""}`}</text></g>;
        })}
        <line x1={48} y1={top} x2={48} y2={baseline} className="dashboard-axis-line" />
        {categories.map((category, index) => {
          const x = 58 + slot * index + slot / 2;
          let accumulated = 0;
          return <g key={category.label}>
            <Link href={category.href} aria-label={`${category.label}: ${totals[index].toFixed(percent ? 1 : 0)}${percent ? "% conversion" : " leads"}`}>
              <title>{`${category.label}${category.detail ? ` - ${category.detail}` : ""}`}</title>
              <text x={x} y={baseline - totals[index] / maximum * plotHeight - 8} textAnchor="middle" className="dashboard-bar-value">{`${totals[index].toFixed(percent ? 1 : 0)}${percent ? "%" : ""}`}</text>
            </Link>
            {category.segments.map(segment => {
              const height = segment.value / maximum * plotHeight;
              accumulated += height;
              return <Link className="dashboard-chart-bar" key={segment.label} href={segment.href} aria-label={`${category.label}, ${segment.label}: ${segment.value.toFixed(percent ? 1 : 0)}${percent ? "% conversion" : " leads"}`}>
                <title>{`${category.label} - ${segment.label}: ${segment.value.toFixed(percent ? 1 : 0)}${percent ? "%" : " leads"}${category.detail ? ` - ${category.detail}` : ""}`}</title>
                <rect x={x - barWidth / 2} y={baseline - accumulated} width={barWidth} height={height} fill={segment.color} rx={2} />
                {segment.value === 0 && <rect x={x - barWidth / 2} y={baseline - 8} width={barWidth} height={8} fill="transparent" />}
              </Link>;
            })}
            <Link href={category.href} aria-label={category.label}>
              <title>{`${category.label}${category.detail ? ` - ${category.detail}` : ""}`}</title>
              <text x={x} y={254} textAnchor="middle" className="dashboard-category-label">{category.label.length > 18 ? `${category.label.slice(0, 15)}...` : category.label}</text>
              {category.detail && <text x={x} y={273} textAnchor="middle" className="dashboard-axis-label">{category.detail}</text>}
            </Link>
          </g>;
        })}
        {!categories.length && <text x={width / 2 + 20} y={132} textAnchor="middle" className="dashboard-empty-plot-label">No data to plot</text>}
      </svg>
    </div>
    {legend.length > 0 && <div className="dashboard-plot-legend">{legend.map(item => <Link href={item.href} key={item.label}><i style={{ background: item.color }} />{item.label}</Link>)}</div>}
    {!categories.length && <p className="dashboard-chart-empty" role="status">{emptyMessage}</p>}
  </div>;
}

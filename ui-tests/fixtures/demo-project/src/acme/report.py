"""Render a short text summary of the sales table."""

from acme.metrics import revenue_by_region, top_region, total_revenue


def summary(rows):
    """Return a multi-line summary string for the given sales rows."""
    lines = [f"Total revenue: ${total_revenue(rows):,.0f}"]
    for region, value in sorted(revenue_by_region(rows).items()):
        lines.append(f"  {region}: ${value:,.0f}")
    lines.append(f"Top region: {top_region(rows)}")
    return "\n".join(lines)

"""Revenue metrics over the Acme sales table."""

from collections import defaultdict


def total_revenue(rows):
    """Return the total revenue across all rows."""
    return sum(row["revenue"] for row in rows)


def revenue_by_region(rows):
    """Sum revenue per region, returned as a dict keyed by region name."""
    totals = defaultdict(float)
    for row in rows:
        totals[row["region"]] += row["revenue"]
    return dict(totals)


def average_order_value(rows):
    """Return mean revenue per order, or 0.0 when there are no rows."""
    if not rows:
        return 0.0
    return total_revenue(rows) / len(rows)


def top_region(rows):
    """Return the region with the highest total revenue, or None if empty."""
    totals = revenue_by_region(rows)
    if not totals:
        return None
    return max(totals, key=totals.get)

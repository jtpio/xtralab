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


def top_region(rows):
    """Return the name of the region with the highest total revenue."""
    totals = revenue_by_region(rows)
    return max(totals, key=totals.get)

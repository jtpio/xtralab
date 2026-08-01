"""Naive linear forecast for monthly revenue."""

from acme.metrics import revenue_by_region


def forecast_next_month(rows):
    """Project next month's revenue from the average month-over-month trend.

    Sums revenue per month, then adds the mean month-over-month delta to the
    most recent month. Returns ``0.0`` when there is not enough history.
    """
    by_month = {}
    for row in rows:
        by_month.setdefault(row["month"], 0.0)
        by_month[row["month"]] += row["revenue"]

    months = sorted(by_month)
    if len(months) < 2:
        return by_month[months[0]] if months else 0.0

    deltas = [by_month[b] - by_month[a] for a, b in zip(months, months[1:])]
    avg_delta = sum(deltas) / len(deltas)
    return by_month[months[-1]] + avg_delta

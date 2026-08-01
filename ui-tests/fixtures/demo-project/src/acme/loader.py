"""Load the Acme sales table from CSV into plain dictionaries."""

import csv


def load_sales(path):
    """Read `path` and return a list of row dicts with typed numeric fields."""
    rows = []
    with open(path, newline="") as handle:
        for row in csv.DictReader(handle):
            rows.append(
                {
                    "region": row["region"],
                    "month": row["month"],
                    "units": int(row["units"]),
                    "revenue": float(row["revenue"]),
                }
            )
    return rows

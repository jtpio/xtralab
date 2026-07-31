# Acme Analytics

A small toolkit for exploring Acme's regional sales data.

## Install

```bash
pip install -e .
```

## Quickstart

```python
from acme.loader import load_sales
from acme.metrics import revenue_by_region

sales = load_sales("data/sales.csv")
print(revenue_by_region(sales))
```

## Forecasting

```python
from acme.forecast import forecast_next_month

print(forecast_next_month(sales))
```

See `notebooks/exploration.ipynb` for a walkthrough.

"""
Generates public/data/regions.json from public/data/rides.json.

Clusters rides geographically, reverse-geocodes each cluster via Mapbox,
and writes region definitions (name + bounds) for the frontend.

Usage:
    python filter-label-generate.py
"""

import json
import math
import os
import urllib.request
import urllib.parse

RIDES_PATH = os.path.join("public", "data", "rides.json")
REGIONS_PATH = os.path.join("public", "data", "regions.json")
CLUSTER_RADIUS_KM = 80  # rides within this distance are grouped together
BOUNDS_PADDING = 0.15    # degrees of padding around cluster bounds

# Override auto-detected names with preferred labels.
# Keys are the auto-detected name; values are what to use instead.
NAME_OVERRIDES = {
    "Sausalito": "Bay Area",
    "Medina": "Seattle",
    "沼津市": "Japan",
    "Santa Ysabel": "San Diego",
    "Röthenbach im Emmental": "Switzerland",
    "Kill Devil Hills": "Outer Banks",
    "Kanahena": "Maui",
    "La Cañada Flintridge": "Los Angeles",
    "Washington": "British Columbia",
    "Stephens City": "Virginia",
}


def load_mapbox_token():
    env_path = os.path.join(os.path.dirname(__file__), ".env")
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if line.startswith("MAPBOX_TOKEN="):
                return line.split("=", 1)[1].strip().strip("\"'")
    raise RuntimeError("MAPBOX_TOKEN not found in .env")


def haversine_km(lat1, lng1, lat2, lng2):
    R = 6371
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = (math.sin(dlat / 2) ** 2 +
         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) *
         math.sin(dlng / 2) ** 2)
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def get_ride_midpoint(feature):
    geom = feature["geometry"]
    if geom["type"] == "MultiLineString":
        coords = [c for seg in geom["coordinates"] for c in seg]
    else:
        coords = geom["coordinates"]
    mid = coords[len(coords) // 2]
    return mid[1], mid[0]  # lat, lng


def cluster_rides(midpoints):
    """Simple single-linkage clustering by distance threshold."""
    n = len(midpoints)
    labels = list(range(n))  # each point starts in its own cluster

    def find(x):
        while labels[x] != x:
            labels[x] = labels[labels[x]]
            x = labels[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            labels[ra] = rb

    for i in range(n):
        for j in range(i + 1, n):
            if haversine_km(midpoints[i][0], midpoints[i][1],
                            midpoints[j][0], midpoints[j][1]) < CLUSTER_RADIUS_KM:
                union(i, j)

    clusters = {}
    for i in range(n):
        root = find(i)
        clusters.setdefault(root, []).append(i)
    return list(clusters.values())


def reverse_geocode(lat, lng, token):
    """Use Mapbox reverse geocoding to get a place name for a coordinate."""
    url = (f"https://api.mapbox.com/geocoding/v5/mapbox.places/"
           f"{lng},{lat}.json?types=place,locality,region"
           f"&access_token={urllib.parse.quote(token)}")
    try:
        with urllib.request.urlopen(url) as resp:
            data = json.loads(resp.read())
        features = data.get("features", [])
        if not features:
            return f"Region ({lat:.1f}, {lng:.1f})"

        place = None
        region = None
        for f in features:
            types = f.get("place_type", [])
            if "place" in types and place is None:
                place = f["text"]
            if "locality" in types and place is None:
                place = f["text"]
            if "region" in types and region is None:
                region = f["text"]

        if place:
            return place
        if region:
            return region
        return features[0]["text"]
    except Exception as e:
        print(f"  Warning: reverse geocode failed for ({lat}, {lng}): {e}")
    return f"Region ({lat:.1f}, {lng:.1f})"


def main():
    token = load_mapbox_token()

    with open(RIDES_PATH, encoding="utf-8") as f:
        rides = json.load(f)

    features = rides["features"]
    midpoints = [get_ride_midpoint(f) for f in features]
    clusters = cluster_rides(midpoints)

    print(f"Found {len(clusters)} region(s) from {len(features)} rides:\n")

    regions = []
    for indices in sorted(clusters, key=lambda c: -len(c)):
        pts = [midpoints[i] for i in indices]
        centroid_lat = sum(p[0] for p in pts) / len(pts)
        centroid_lng = sum(p[1] for p in pts) / len(pts)

        min_lat = min(p[0] for p in pts) - BOUNDS_PADDING
        max_lat = max(p[0] for p in pts) + BOUNDS_PADDING
        min_lng = min(p[1] for p in pts) - BOUNDS_PADDING
        max_lng = max(p[1] for p in pts) + BOUNDS_PADDING

        name = reverse_geocode(centroid_lat, centroid_lng, token)
        name = NAME_OVERRIDES.get(name, name)

        # Avoid duplicate names
        existing_names = [r["name"] for r in regions]
        if name in existing_names:
            name2 = reverse_geocode(centroid_lat, centroid_lng, token)
            if name2 != name:
                name = name2
            else:
                name = f"{name} ({len(indices)})"

        region = {
            "name": name,
            "bounds": [
                [round(min_lng, 4), round(min_lat, 4)],
                [round(max_lng, 4), round(max_lat, 4)]
            ],
            "count": len(indices)
        }
        regions.append(region)
        print(f"  {name}: {len(indices)} ride(s)")

    with open(REGIONS_PATH, "w") as f:
        json.dump(regions, f, indent=2)

    print(f"\nWrote {len(regions)} regions to {REGIONS_PATH}")


if __name__ == "__main__":
    main()

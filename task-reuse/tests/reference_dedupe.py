"""Independent prewritten script for the valid-CSV performance baseline."""

import csv
import sys
from datetime import datetime
from pathlib import Path


def deduplicate(source, destination, timestamp_column):
    with source.open(encoding="utf-8-sig", newline="") as stream:
        reader = csv.reader(stream)
        header = next(reader)
        key_column = header.index("邮箱")
        order_column = header.index(timestamp_column)
        winners = {}
        conflicting = set()
        for position, row in enumerate(reader):
            key = row[key_column].strip().casefold()
            stamp = datetime.fromisoformat(row[order_column].strip().replace("Z", "+00:00"))
            previous = winners.get(key)
            if previous is None or stamp > previous[1]:
                winners[key] = (position, stamp, row)
                conflicting.discard(key)
            elif stamp == previous[1] and row != previous[2]:
                conflicting.add(key)
    if conflicting:
        raise ValueError("Conflicting latest records")
    with destination.open("x", encoding="utf-8", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(header)
        writer.writerows(winner[2] for winner in sorted(winners.values()))


if __name__ == "__main__":
    deduplicate(Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3])

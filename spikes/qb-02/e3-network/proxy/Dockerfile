# Ⓟ for E3: the design's candidate image (Canonical ubuntu/squid) plus the
# Unix-socket bridge. The run records the resolved base digest.
FROM ubuntu/squid:latest
RUN apt-get update \
 && apt-get install -y --no-install-recommends socat \
 && rm -rf /var/lib/apt/lists/*
COPY squid.conf /etc/squid/squid.conf
COPY entry.sh /entry.sh
RUN chmod 0755 /entry.sh
ENTRYPOINT ["/entry.sh"]

# QB-34: a real spreadsheet client for CSV-import verification (LibreOffice Calc, headless).
FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends libreoffice-calc-nogui unzip \
 && rm -rf /var/lib/apt/lists/*
RUN useradd -m lo
USER lo
WORKDIR /work

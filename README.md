# ScanPDF - Bank Statement Extractor

ScanPDF is a Node.js utility that automatically extracts bank transactions from PDF statements using OpenAI's GPT-4o-mini model. It processes PDF files, structures the data, and saves it into organized CSV files.

## Features

- **Automated Extraction**: Uses AI to accurately extract date, description, amount, and currency from bank statements.
- **Automatic Grouping**: Organizes transactions into separate CSV files based on the directory structure.
- **Deduplication**: Automatically removes duplicate transactions when merging new data with existing CSVs.
- **Sorting**: Ensures transactions are chronologically sorted in the output.
- **Progress Tracking**: Real-time console output showing processing progress and estimated time remaining.

## Prerequisites

- Node.js (v18 or higher recommended)
- An OpenAI API Key

## Setup

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Configure API Key**:
   Create a `.env` file in the root directory of the project and add your OpenAI API key:
   ```env
   OPENAI_API_KEY=your_actual_api_key_here
   ```

## Usage

### Folder Structure & Grouping

The application looks for PDF files in the `./data` directory. The key feature is how it handles **direct subdirectories**:

- Any PDF file found inside a direct subdirectory of `./data/` will be grouped into a CSV file named after that subdirectory.
- For example:
    - `data/DKB/statement_2023.pdf` -> results in `DKB.csv`
    - `data/N26/january.pdf` -> results in `N26.csv`
- PDF files located directly in the root of `data/` (not in a subdirectory) will be saved to `kontoauszuege.csv` by default.

### Running the Script

Place your PDF statements into the appropriate subdirectories within `data/` and run:

```bash
npm start
```

The script will scan all files, call the OpenAI API for extraction, and generate/update the CSV files in the project root.

## Dependencies

- `openai`: For AI-powered data extraction.
- `pdf-parse`: To extract raw text from PDF files.
- `csv-writer` & `fast-csv`: For generating and reading CSV files.
- `dotenv`: To manage environment variables.
- `tsx`: To run TypeScript directly.

## License

MIT

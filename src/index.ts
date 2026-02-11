import fs from "fs-extra";
import path from "path";
import {PDFParse} from "pdf-parse";
import {createObjectCsvWriter} from "csv-writer";
import OpenAI from "openai";
import readline from "node:readline";
import "dotenv/config";

const openai = new OpenAI({apiKey: process.env.OPENAI_API_KEY});

const DATA_DIR = "./data";
const OUTPUT_FILE = "./kontoauszuege.csv";

const csvWriter = createObjectCsvWriter({
  path: OUTPUT_FILE,
  header: [
    {id: "date", title: "Date"},
    {id: "description", title: "Description"},
    {id: "amount", title: "Amount"},
    {id: "currency", title: "Currency"},
  ],
  append: false,
});

async function extractText(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  const parser = new PDFParse({data: buffer});
  const data = await parser.getText();
  await parser.destroy();
  return data.text;
}

async function extractStructured(text: string): Promise<any[]> {
  if (!text.trim()) return [];

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: {type: "json_object"},
      messages: [
        {
          role: "system",
          content:
            "Extract all bank transactions as JSON array under key 'transactions'. " +
            "Fields: date (ISO), description, amount (number), currency. " +
            "Important: The 'description' must capture EVERY detail from the transaction text without any summarization or omission. " +
            "If the description consists of multiple lines in the source, include the content of all those lines. " +
            "Preserve all reference numbers, dates, and names found in the transaction details.",
        },
        {
          role: "user",
          content: text,
        },
      ],
    });

    const content = response.choices[0].message.content;
    if (!content) return [];

    const parsed = JSON.parse(content);
    const transactions = parsed.transactions || [];

    // Clean up descriptions: replace any newlines/multiple spaces with a single space
    return transactions.map((t: any) => ({
      ...t,
      description: typeof t.description === "string"
        ? t.description.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim()
        : t.description,
    }));
  } catch (error) {
    console.error("Error calling OpenAI:", error);
    return [];
  }
}

async function getPdfFiles(dir: string): Promise<string[]> {
  let results: string[] = [];
  const list = await fs.readdir(dir);

  for (const file of list) {
    const filePath = path.join(dir, file);
    const stat = await fs.stat(filePath);

    if (stat && stat.isDirectory()) {
      results = results.concat(await getPdfFiles(filePath));
    } else if (file.toLowerCase().endsWith(".pdf")) {
      results.push(filePath);
    }
  }

  return results;
}

function formatTime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
}

async function run() {
  console.log("Scanning for PDF files in:", DATA_DIR);
  if (!fs.existsSync(DATA_DIR)) {
    console.error(`Directory ${DATA_DIR} does not exist.`);
    return;
  }
  const files = await getPdfFiles(DATA_DIR);
  const totalFiles = files.length;
  console.log(`Found ${totalFiles} PDF files.`);

  let allTransactions: any[] = [];
  let processed = 0;
  let skippedCount = 0;
  const errors: string[] = [];
  const startTime = Date.now();

  for (const file of files) {
    try {
      const text = await extractText(file);
      const transactions = await extractStructured(text);
      allTransactions.push(...transactions);
    } catch (error) {
      errors.push(file);
    } finally {
      processed++;
      const elapsed = Date.now() - startTime;
      const avgTimePerFile = elapsed / processed;
      const estimatedRemaining = avgTimePerFile * (totalFiles - processed);
      const percent = ((processed / totalFiles) * 100).toFixed(1);
      const progressLine = `[${percent}%] ${processed}/${totalFiles} | Zeit: ${formatTime(elapsed)} | Verbleibend: ${formatTime(estimatedRemaining)} | Fehler: ${errors.length} | Übersprungen: ${skippedCount}`;

      if (process.stdout.isTTY) {
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
        process.stdout.write(progressLine);
      } else {
        // Fallback for non-TTY environments: only print every 10% to avoid flooding
        if (processed % Math.max(1, Math.floor(totalFiles / 10)) === 0 || processed === totalFiles) {
          process.stdout.write(`\n${progressLine}`);
        }
      }
    }
  }

  console.log("\n"); // Move to new line after progress
  if (allTransactions.length > 0) {
    await csvWriter.writeRecords(allTransactions);
    console.log("Done →", OUTPUT_FILE);
  } else {
    console.log("No transactions found to write.");
  }
}

run().catch(console.error);

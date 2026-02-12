import fs from "fs-extra";
import path from "path";
import {PDFParse} from "pdf-parse";
import {createObjectCsvWriter} from "csv-writer";
import OpenAI from "openai";
import readline from "node:readline";
import "dotenv/config";
import * as csv from "fast-csv";

const openai = new OpenAI({apiKey: process.env.OPENAI_API_KEY});

const DATA_DIR = "./data";
const DEFAULT_OUTPUT = "kontoauszuege.csv";

function getCsvWriter(outputPath: string) {
  return createObjectCsvWriter({
    path: outputPath,
    header: [
      {id: "date", title: "Date"},
      {id: "description", title: "Description"},
      {id: "amount", title: "Amount"},
      {id: "currency", title: "Currency"},
    ],
    append: false,
  });
}

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

function getGroupName(file: string): string {
  const relativePath = path.relative(DATA_DIR, file);
  const parts = relativePath.split(path.sep);
  if (parts.length > 1) {
    return `${parts[0]}.csv`;
  }
  return DEFAULT_OUTPUT;
}

async function loadExistingTransactions(filePath: string): Promise<any[]> {
  if (!fs.existsSync(filePath)) return [];

  return new Promise((resolve, reject) => {
    const transactions: any[] = [];
    fs.createReadStream(filePath)
      .pipe(csv.parse({headers: true}))
      .on("data", (row) => {
        transactions.push({
          date: row.Date,
          description: row.Description,
          amount: parseFloat(row.Amount),
          currency: row.Currency,
        });
      })
      .on("end", () => resolve(transactions))
      .on("error", (error) => reject(error));
  });
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

  // Group files
  const filesByGroup: Record<string, string[]> = {};
  for (const file of files) {
    const groupName = getGroupName(file);
    if (!filesByGroup[groupName]) {
      filesByGroup[groupName] = [];
    }
    filesByGroup[groupName].push(file);
  }

  // Pre-calculate counts per group
  const groupStats: Record<string, { total: number; processed: number }> = {};
  for (const [groupName, groupFiles] of Object.entries(filesByGroup)) {
    groupStats[groupName] = {total: groupFiles.length, processed: 0};
  }

  let totalProcessed = 0;
  const errors: string[] = [];
  const startTime = Date.now();

  for (const groupName of Object.keys(filesByGroup)) {
    const groupFiles = filesByGroup[groupName];
    const newTransactions: any[] = [];

    for (const file of groupFiles) {
      try {
        const text = await extractText(file);
        const transactions = await extractStructured(text);
        newTransactions.push(...transactions);
      } catch (error) {
        errors.push(file);
      } finally {
        totalProcessed++;
        groupStats[groupName].processed++;

        const elapsed = Date.now() - startTime;
        const avgTimePerFile = elapsed / totalProcessed;
        const estimatedRemaining = avgTimePerFile * (totalFiles - totalProcessed);
        const totalPercent = ((totalProcessed / totalFiles) * 100).toFixed(1);

        let progressLine = `Gesamt: [${totalPercent}%] ${totalProcessed}/${totalFiles} | Zeit: ${formatTime(elapsed)} | Verbleibend: ${formatTime(estimatedRemaining)}`;

        // Add group progress
        const groupParts = Object.entries(groupStats).map(([name, stats]) => {
          const percent = ((stats.processed / stats.total) * 100).toFixed(0);
          return `${name.replace(".csv", "")}: ${stats.processed}/${stats.total} (${percent}%)`;
        });

        if (process.stdout.isTTY) {
          // Move up one line if we already printed a group line (except for the first file)
          if (totalProcessed > 1) {
            readline.moveCursor(process.stdout, 0, -1);
          }
          readline.clearLine(process.stdout, 0);
          readline.cursorTo(process.stdout, 0);
          process.stdout.write(progressLine + "\n");
          readline.clearLine(process.stdout, 0);
          readline.cursorTo(process.stdout, 0);
          process.stdout.write(`Groups: ${groupParts.join(" | ")} | Fehler: ${errors.length}`);
        } else {
          if (totalProcessed % Math.max(1, Math.floor(totalFiles / 10)) === 0 || totalProcessed === totalFiles) {
            process.stdout.write(`\n${progressLine} | Groups: ${groupParts.join(" | ")}`);
          }
        }
      }
    }

    // Process and write the group's CSV after all files in the group are processed
    if (newTransactions.length > 0) {
      const existingTransactions = await loadExistingTransactions(groupName);
      const allTransactions = [...existingTransactions, ...newTransactions];

      // De-duplicate
      const seen = new Set();
      const uniqueTransactions = allTransactions.filter((t) => {
        const key = `${t.date}|${t.description}|${t.amount}|${t.currency}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      // Temporal sorting
      uniqueTransactions.sort((a, b) => {
        const dateA = a.date || "";
        const dateB = b.date || "";
        return dateA.localeCompare(dateB);
      });

      const writer = getCsvWriter(groupName);
      await writer.writeRecords(uniqueTransactions);
    }
  }

  console.log("\n\nProcessing complete.");
  if (errors.length > 0) {
    console.log("Errors in following files:", errors);
  }
}

run().catch(console.error);

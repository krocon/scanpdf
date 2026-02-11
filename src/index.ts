import fs from "fs-extra";
import path from "path";
import {PDFParse} from "pdf-parse";
import {createObjectCsvWriter} from "csv-writer";
import OpenAI from "openai";
import readline from "node:readline";
import "dotenv/config";

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

async function run() {
  console.log("Scanning for PDF files in:", DATA_DIR);
  if (!fs.existsSync(DATA_DIR)) {
    console.error(`Directory ${DATA_DIR} does not exist.`);
    return;
  }
  const files = await getPdfFiles(DATA_DIR);
  const totalFiles = files.length;
  console.log(`Found ${totalFiles} PDF files.`);

  // Pre-calculate counts per group
  const groupStats: Record<string, { total: number; processed: number }> = {};
  for (const file of files) {
    const groupName = getGroupName(file);
    if (!groupStats[groupName]) {
      groupStats[groupName] = { total: 0, processed: 0 };
    }
    groupStats[groupName].total++;
  }

  const transactionsByGroup: Record<string, any[]> = {};
  let totalProcessed = 0;
  let skippedCount = 0;
  const errors: string[] = [];
  const startTime = Date.now();

  for (const file of files) {
    const groupName = getGroupName(file);
    try {
      const text = await extractText(file);
      const transactions = await extractStructured(text);
      
      if (!transactionsByGroup[groupName]) {
        transactionsByGroup[groupName] = [];
      }
      transactionsByGroup[groupName].push(...transactions);
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
        return `${name.replace('.csv', '')}: ${stats.processed}/${stats.total} (${percent}%)`;
      });
      
      const fullProgress = `${progressLine}\nGroups: ${groupParts.join(" | ")} | Fehler: ${errors.length}`;

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

  console.log("\n"); // Move to new line after progress
  
  const groups = Object.keys(transactionsByGroup);
  if (groups.length > 0) {
    for (const groupName of groups) {
      const transactions = transactionsByGroup[groupName];
      if (transactions.length > 0) {
        const writer = getCsvWriter(groupName);
        await writer.writeRecords(transactions);
        console.log(`Done → ${groupName} (${transactions.length} transactions)`);
      }
    }
  } else {
    console.log("No transactions found to write.");
  }
}

run().catch(console.error);

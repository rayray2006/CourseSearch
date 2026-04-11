import { tool } from "ai";
import { z } from "zod";
import { getDb } from "../db";

export const searchProfessors = tool({
  description:
    "Search RateMyProfessors data for JHU professors. Returns ratings, difficulty, and would-take-again percentage. Use when users ask about a professor's reputation, compare professors, or want to know who the best/worst rated instructors are.",
  inputSchema: z.object({
    name: z
      .string()
      .optional()
      .describe(
        "Professor name (partial match). Can be first, last, or full name."
      ),
    department: z
      .string()
      .optional()
      .describe("RMP department, e.g. 'Computer Science', 'Mathematics'"),
    minRating: z
      .number()
      .optional()
      .describe("Minimum average rating (1-5)"),
    maxDifficulty: z
      .number()
      .optional()
      .describe("Maximum difficulty (1-5)"),
    sortBy: z
      .enum(["rating_desc", "rating_asc", "difficulty_desc", "difficulty_asc", "num_ratings_desc"])
      .optional()
      .describe("Sort order for results"),
  }),
  execute: async (input) => {
    const db = getDb();
    const conditions: string[] = [];
    const params: Record<string, string | number> = {};

    if (input.name) {
      const words = input.name.split(/\s+/).filter((w) => w.length > 0);
      words.forEach((word, i) => {
        const p = `name${i}`;
        conditions.push(
          `(first_name LIKE @${p} OR last_name LIKE @${p})`
        );
        params[p] = `%${word}%`;
      });
    }
    if (input.department) {
      conditions.push("department LIKE @dept");
      params.dept = `%${input.department}%`;
    }
    if (input.minRating !== undefined) {
      conditions.push("avg_rating >= @minRating");
      params.minRating = input.minRating;
    }
    if (input.maxDifficulty !== undefined) {
      conditions.push("avg_difficulty <= @maxDifficulty");
      params.maxDifficulty = input.maxDifficulty;
    }

    // Always require at least 1 rating
    conditions.push("num_ratings > 0");

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    let orderBy = "avg_rating DESC";
    if (input.sortBy === "rating_asc") orderBy = "avg_rating ASC";
    else if (input.sortBy === "difficulty_desc") orderBy = "avg_difficulty DESC";
    else if (input.sortBy === "difficulty_asc") orderBy = "avg_difficulty ASC";
    else if (input.sortBy === "num_ratings_desc") orderBy = "num_ratings DESC";

    const sql = `
      SELECT first_name, last_name, department, avg_rating, avg_difficulty,
             num_ratings, would_take_again_pct
      FROM professors
      ${where}
      ORDER BY ${orderBy}
      LIMIT 15
    `;

    const rows = db.prepare(sql).all(params);
    return { count: rows.length, professors: rows };
  },
});

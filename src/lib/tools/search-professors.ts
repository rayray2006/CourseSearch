import { tool } from "ai";
import { z } from "zod";
import { getDb } from "../db";

export const searchProfessors = tool({
  description:
    "Search RateMyProfessors data for JHU professors. Returns ratings, difficulty, and would-take-again percentage. IMPORTANT: For 'best' or 'highest rated' queries, use sortBy 'rating_desc' WITHOUT setting minRating. For 'hardest', use sortBy 'difficulty_desc'. Never filter to an exact rating — always sort and return the top results.",
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

export const findRatedInstructors = tool({
  description:
    "Find the best/worst/easiest/hardest professors who are actually teaching Fall 2026 courses. Joins RMP ratings with the course catalog. Use this for ANY superlative query like 'best rated professor teaching this fall', 'hardest CS instructor', 'easiest professor with a course'.",
  inputSchema: z.object({
    department: z
      .string()
      .optional()
      .describe("Filter courses by department, e.g. 'Computer Science'"),
    sortBy: z
      .enum(["rating_desc", "rating_asc", "difficulty_desc", "difficulty_asc"])
      .describe(
        "How to rank: 'rating_desc' for best, 'rating_asc' for worst, 'difficulty_desc' for hardest, 'difficulty_asc' for easiest"
      ),
    minRatings: z
      .number()
      .optional()
      .describe("Minimum number of RMP ratings to be considered (default 3). Higher = more reliable."),
  }),
  execute: async (input) => {
    const db = getDb();
    const conditions: string[] = ["p.num_ratings >= @minRatings"];
    const params: Record<string, string | number> = {
      minRatings: input.minRatings ?? 3,
    };

    if (input.department) {
      conditions.push("c.department LIKE @dept");
      params.dept = `%${input.department}%`;
    }

    const where = conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : "";

    let orderBy = "p.avg_rating DESC";
    if (input.sortBy === "rating_asc") orderBy = "p.avg_rating ASC";
    else if (input.sortBy === "difficulty_desc") orderBy = "p.avg_difficulty DESC";
    else if (input.sortBy === "difficulty_asc") orderBy = "p.avg_difficulty ASC";

    const sql = `
      SELECT DISTINCT
        p.first_name, p.last_name, p.department as rmp_department,
        p.avg_rating, p.avg_difficulty, p.num_ratings, p.would_take_again_pct,
        c.offering_name, c.title as course_title, c.meetings, c.department as course_department
      FROM professors p
      JOIN courses c ON c.instructors_full_name LIKE '%' || p.last_name || '%'
      WHERE c.status != 'Canceled'
      ${where}
      ORDER BY ${orderBy}
      LIMIT 10
    `;

    const rows = db.prepare(sql).all(params);
    return { count: rows.length, results: rows };
  },
});

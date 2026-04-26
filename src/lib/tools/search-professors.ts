import { tool } from "ai";
import { z } from "zod";
import { supabase } from "../supabase";
import { getActiveTerm } from "./schedule-tools";

export const searchProfessors = tool({
  description: "Search RateMyProfessors data. For 'best' queries: sortBy=rating_desc, no minRating.",
  inputSchema: z.object({
    name: z.string().optional(),
    department: z.string().optional(),
    minRating: z.number().optional(),
    maxDifficulty: z.number().optional(),
    sortBy: z.enum(["rating_desc", "rating_asc", "difficulty_desc", "difficulty_asc", "num_ratings_desc"]).optional(),
  }),
  execute: async (input) => {
    let query = supabase
      .from("professors")
      .select("first_name, last_name, department, avg_rating, avg_difficulty, num_ratings, would_take_again_pct")
      .gt("num_ratings", 0)
      .limit(15);

    if (input.name) {
      // Strip punctuation and split into words for flexible matching
      const words = input.name.replace(/[,;.:]/g, " ").split(/\s+/).filter((w) => w.length > 1);
      for (const word of words) {
        query = query.or(`first_name.ilike.%${word}%,last_name.ilike.%${word}%`);
      }
    }
    if (input.department) query = query.ilike("department", `%${input.department}%`);
    if (input.minRating !== undefined) query = query.gte("avg_rating", input.minRating);
    if (input.maxDifficulty !== undefined) query = query.lte("avg_difficulty", input.maxDifficulty);

    // Sorting
    const sortMap: Record<string, { column: string; ascending: boolean }> = {
      rating_desc: { column: "avg_rating", ascending: false },
      rating_asc: { column: "avg_rating", ascending: true },
      difficulty_desc: { column: "avg_difficulty", ascending: false },
      difficulty_asc: { column: "avg_difficulty", ascending: true },
      num_ratings_desc: { column: "num_ratings", ascending: false },
    };
    const sort = sortMap[input.sortBy || "rating_desc"];
    query = query.order(sort.column, { ascending: sort.ascending });

    const { data, error } = await query;
    if (error) return { count: 0, professors: [], error: error.message };
    return { count: (data || []).length, professors: data || [] };
  },
});

export const findRatedInstructors = tool({
  description:
    "Find best/worst professors teaching this semester.",
  inputSchema: z.object({
    department: z.string().optional(),
    sortBy: z.enum(["rating_desc", "rating_asc", "difficulty_desc", "difficulty_asc"]),
    minRatings: z.number().optional(),
  }),
  execute: async (input) => {
    // Get professors with enough ratings
    const minRatings = input.minRatings ?? 3;
    const sortMap: Record<string, { column: string; ascending: boolean }> = {
      rating_desc: { column: "avg_rating", ascending: false },
      rating_asc: { column: "avg_rating", ascending: true },
      difficulty_desc: { column: "avg_difficulty", ascending: false },
      difficulty_asc: { column: "avg_difficulty", ascending: true },
    };
    const sort = sortMap[input.sortBy];

    const { data: profs } = await supabase
      .from("professors")
      .select("first_name, last_name, department, avg_rating, avg_difficulty, num_ratings, would_take_again_pct")
      .gte("num_ratings", minRatings)
      .order(sort.column, { ascending: sort.ascending })
      .limit(50);

    if (!profs || profs.length === 0) return { count: 0, results: [] };

    // For each professor, check if they teach a course
    const results: {
      first_name: string; last_name: string; rmp_department: string;
      avg_rating: number; avg_difficulty: number; num_ratings: number;
      would_take_again_pct: number | null;
      offering_name: string; course_title: string; meetings: string; course_department: string;
    }[] = [];

    for (const prof of profs) {
      if (results.length >= 10) break;

      let courseQuery = supabase
        .from("courses")
        .select("offering_name, title, meetings, department")
        .eq("term", getActiveTerm())
        .ilike("instructors_full_name", `%${prof.last_name}%`)
        .neq("status", "Canceled")
        .limit(1);

      if (input.department) courseQuery = courseQuery.ilike("department", `%${input.department}%`);

      const { data: courses } = await courseQuery;
      if (courses && courses.length > 0) {
        results.push({
          first_name: prof.first_name,
          last_name: prof.last_name,
          rmp_department: prof.department,
          avg_rating: prof.avg_rating,
          avg_difficulty: prof.avg_difficulty,
          num_ratings: prof.num_ratings,
          would_take_again_pct: prof.would_take_again_pct,
          offering_name: courses[0].offering_name,
          course_title: courses[0].title,
          meetings: courses[0].meetings,
          course_department: courses[0].department,
        });
      }
    }

    return { count: results.length, results };
  },
});

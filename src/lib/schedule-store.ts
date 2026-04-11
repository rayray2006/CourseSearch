// Server-side in-memory schedule store
// In a real app this would be a database, but for a single-user local app this is fine

export interface ScheduledCourse {
  offering_name: string;
  section_name: string;
  title: string;
  credits: string;
  department: string;
  school_name: string;
  level: string;
  meetings: string;
  location: string;
  building: string;
  instructors_full_name: string;
  instruction_method: string;
  status: string;
}

const schedule: Map<string, ScheduledCourse> = new Map();

function key(offering_name: string, section_name: string) {
  return `${offering_name}::${section_name}`;
}

export function addToSchedule(course: ScheduledCourse): { success: boolean; message: string } {
  const k = key(course.offering_name, course.section_name);
  if (schedule.has(k)) {
    return { success: false, message: `${course.offering_name} section ${course.section_name} is already in your schedule.` };
  }
  schedule.set(k, course);
  return { success: true, message: `Added ${course.offering_name} (${course.title}) section ${course.section_name} to your schedule.` };
}

export function removeFromSchedule(offering_name: string, section_name: string): { success: boolean; message: string } {
  const k = key(offering_name, section_name);
  if (!schedule.has(k)) {
    return { success: false, message: `${offering_name} section ${section_name} is not in your schedule.` };
  }
  schedule.delete(k);
  return { success: true, message: `Removed ${offering_name} section ${section_name} from your schedule.` };
}

export function getSchedule(): ScheduledCourse[] {
  return Array.from(schedule.values());
}

export function clearSchedule(): { success: boolean; message: string } {
  schedule.clear();
  return { success: true, message: "Schedule cleared." };
}

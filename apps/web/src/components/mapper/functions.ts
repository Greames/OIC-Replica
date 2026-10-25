// The mapper's function palette. In a template, {} is replaced by the
// selected field's current expression.

export interface PaletteFunction {
  name: string;
  template: string;
  description: string;
}

export const FUNCTION_GROUPS: { group: string; functions: PaletteFunction[] }[] = [
  {
    group: "Text",
    functions: [
      { name: "$string", template: "$string({})", description: "Turn a value into text." },
      { name: "$uppercase", template: "$uppercase({})", description: "UPPER CASE." },
      { name: "$lowercase", template: "$lowercase({})", description: "lower case." },
      { name: "$trim", template: "$trim({})", description: "Remove spaces at both ends." },
      { name: "$substring", template: "$substring({}, 0, 10)", description: "Part of the text: start, length." },
      { name: "$replace", template: '$replace({}, "old", "new")', description: "Replace text." },
      { name: "$join", template: '$join({}, ", ")', description: "Join a list into one text." },
      { name: "$split", template: '$split({}, ",")', description: "Split text into a list." },
      { name: "$pad", template: '$pad({}, 10, "0")', description: "Pad to a width (negative: on the left)." },
      { name: "&", template: '{} & " " & ""', description: "Join texts together." },
    ],
  },
  {
    group: "Numbers",
    functions: [
      { name: "$number", template: "$number({})", description: "Turn text into a number." },
      { name: "$round", template: "$round({}, 2)", description: "Round to decimals." },
      { name: "$sum", template: "$sum({})", description: "Add up a list." },
      { name: "$count", template: "$count({})", description: "How many items." },
      { name: "$average", template: "$average({})", description: "Average of a list." },
      { name: "$max", template: "$max({})", description: "Largest of a list." },
      { name: "$min", template: "$min({})", description: "Smallest of a list." },
      { name: "× 100", template: "$round({} * 100)", description: "Amount to cents." },
      { name: "$formatNumber", template: '$formatNumber({}, "#,##0.00")', description: "Format a number as text." },
    ],
  },
  {
    group: "Dates",
    functions: [
      { name: "$now", template: "$now()", description: "The current time (ISO 8601)." },
      { name: "$toMillis", template: "$toMillis({})", description: "ISO date to milliseconds." },
      { name: "$fromMillis", template: "$fromMillis({})", description: "Milliseconds to an ISO date." },
      {
        name: "date only",
        template: '$fromMillis($toMillis({}), "[Y0001]-[M01]-[D01]")',
        description: "Format as YYYY-MM-DD.",
      },
    ],
  },
  {
    group: "Logic",
    functions: [
      { name: "if … then … else", template: '{} ? "yes" : "no"', description: "Choose a value by a condition." },
      { name: "default", template: '$exists({}) ? {} : ""', description: "A fallback when the value is missing." },
      { name: "$exists", template: "$exists({})", description: "true when the value is there." },
      { name: "$boolean", template: "$boolean({})", description: "Turn a value into true or false." },
      { name: "$not", template: "$not({})", description: "The opposite of true or false." },
    ],
  },
  {
    group: "Lists",
    functions: [
      { name: "first", template: "{}[0]", description: "The first item." },
      { name: "filter", template: "{}[total > 0]", description: "Only the items matching a condition." },
      { name: "$distinct", template: "$distinct({})", description: "Without duplicates." },
      { name: "$sort", template: "$sort({})", description: "Sorted." },
      { name: "always a list", template: "[{}]", description: "Keep a list a list, even with one item." },
    ],
  },
];

export function applyTemplate(template: string, current: string): string {
  return template.includes("{}") ? template.replaceAll("{}", current.trim() || "") : template;
}

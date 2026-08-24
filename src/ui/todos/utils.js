const TODO_CATEGORY_OPTIONS = [
  { value: "rock", label: "Rock" },
  { value: "pebble", label: "Pebble" },
  { value: "sand", label: "Sand" },
];

const CATEGORY_LABELS = new Map(TODO_CATEGORY_OPTIONS.map((option) => [option.value, option.label]));
const CATEGORY_ORDER = new Map(
  TODO_CATEGORY_OPTIONS.map((option, index) => [option.value, index]),
);

function formatDisplayDate(isoString) {
  if (!isoString) {
    return "";
  }
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function toDateInputValue(isoString) {
  if (!isoString) {
    return "";
  }
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDateInputValue(value) {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Invalid date");
  }
  return date.toISOString();
}

function sortTodos(todos) {
  return [...todos].sort((left, right) => {
    const leftCategory = CATEGORY_ORDER.get(left.category) ?? CATEGORY_ORDER.size;
    const rightCategory = CATEGORY_ORDER.get(right.category) ?? CATEGORY_ORDER.size;
    if (leftCategory !== rightCategory) {
      return leftCategory - rightCategory;
    }
    if (left.starred !== right.starred) {
      return left.starred ? -1 : 1;
    }
    const leftDue = getDueTime(left);
    const rightDue = getDueTime(right);
    if (leftDue === rightDue) {
      const leftCreated = getCreatedTime(left);
      const rightCreated = getCreatedTime(right);
      return rightCreated - leftCreated;
    }
    return leftDue - rightDue;
  });
}

function getDueTime(todo) {
  if (!todo.dueDate) {
    return Number.POSITIVE_INFINITY;
  }
  const time = new Date(todo.dueDate).getTime();
  return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time;
}

function getCreatedTime(todo) {
  const created = todo.createdAt ?? todo.updatedAt ?? 0;
  const time = new Date(created).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function getParentCandidates(items, category, currentId) {
  if (category === "pebble") {
    return items.filter((item) => item.category === "rock" && item.id !== currentId);
  }
  if (category === "sand") {
    return items.filter((item) => item.category === "pebble" && item.id !== currentId);
  }
  return [];
}

export {
  TODO_CATEGORY_OPTIONS,
  CATEGORY_LABELS,
  formatDisplayDate,
  toDateInputValue,
  parseDateInputValue,
  sortTodos,
  getParentCandidates,
};

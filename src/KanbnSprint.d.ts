// Note that Date properties will be converted to strings (ISO) when a task is serialized and passed as a prop
declare type KanbnSprint = {
  start: string;
  name: string;
  description?: string;
};

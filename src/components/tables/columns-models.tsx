import type { ColumnDef } from "@tanstack/react-table";

export const columns: ColumnDef<any>[] = [
  {
    accessorKey: "alias",
    header: "Alias",
  },
  {
    accessorKey: "provider",
    header: "Provider",
  },
  {
    accessorKey: "modelId",
    header: "Model ID",
  },
];

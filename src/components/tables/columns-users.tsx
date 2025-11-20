import type { ColumnDef } from "@tanstack/react-table";

export const columns: ColumnDef<any>[] = [
  {
    accessorKey: "email",
    header: "Email",
    cell: ({ row }) => {
      const email = row.getValue("email") as string;
      const image = row.original.image;
      return (
        <div className="flex items-center gap-2">
          {image && <img src={image} alt={email} className="w-8 h-8 rounded" />}
          {email}
        </div>
      );
    },
  },
  {
    accessorKey: "name",
    header: "Name",
  },
];

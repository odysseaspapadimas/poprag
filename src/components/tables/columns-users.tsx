import type { ColumnDef } from "@tanstack/react-table";
import { Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { FirebaseUser } from "@/lib/firebase/types";
import { formatFirebaseTimestamp } from "@/lib/firebase/types";

/**
 * User table columns for Firebase users
 */

export const columns = (
  onViewUser: (uid: string) => void,
): ColumnDef<FirebaseUser>[] => [
  {
    accessorKey: "email",
    header: "Email",
    cell: ({ row }) => {
      const email = row.getValue("email") as string;
      const photo_url = row.original.photo_url;
      return (
        <div className="flex items-center gap-2">
          {photo_url && (
            <img src={photo_url} alt={email} className="w-8 h-8 rounded-full" />
          )}
          {email}
        </div>
      );
    },
  },
  {
    accessorKey: "display_name",
    header: "Name",
  },
  {
    accessorKey: "ApiCalls",
    header: "API Calls",
    cell: ({ row }) => {
      const calls = row.getValue("ApiCalls") as number;
      const limit = row.original.ApiCallsLimit;
      return `${calls} / ${limit}`;
    },
  },
  {
    accessorKey: "responsePreference",
    header: "Preference",
    cell: ({ row }) => {
      const pref = row.getValue("responsePreference") as string;
      return pref.charAt(0).toUpperCase() + pref.slice(1);
    },
  },
  {
    accessorKey: "created_time",
    header: "Created",
    cell: ({ row }) => {
      const created = row.original.created_time;
      return formatFirebaseTimestamp(created);
    },
  },
  {
    id: "actions",
    cell: ({ row }) => {
      return (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onViewUser(row.original.uid)}
        >
          <Eye className="h-4 w-4 mr-2" />
          View
        </Button>
      );
    },
  },
];

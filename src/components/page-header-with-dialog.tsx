import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import React, { ReactNode, useState } from "react";

interface PageHeaderWithDialogProps {
  title: string;
  description: string;
  buttonText: string;
  dialogTitle: string;
  dialogDescription?: string;
  children: ReactNode;
}

export function PageHeaderWithDialog({
  title,
  description,
  buttonText,
  dialogTitle,
  dialogDescription,
  children,
}: PageHeaderWithDialogProps) {
  const [dialogOpen, setDialogOpen] = useState(false);

  const handleSuccess = () => {
    setDialogOpen(false);
  };

  // Clone children and pass handleSuccess if it's a function component
  const childrenWithProps = React.isValidElement(children)
    ? React.cloneElement(children as React.ReactElement<any>, { onSuccess: handleSuccess })
    : children;

  return (
    <>
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-3xl font-bold">{title}</h1>
          <p className="text-muted-foreground mt-2">{description}</p>
        </div>
        <Button onClick={() => setDialogOpen(true)}>{buttonText}</Button>
      </div>
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{dialogTitle}</DialogTitle>
            {dialogDescription && (
              <DialogDescription>{dialogDescription}</DialogDescription>
            )}
          </DialogHeader>
          {childrenWithProps}
        </DialogContent>
      </Dialog>
    </>
  );
}

export default PageHeaderWithDialog;
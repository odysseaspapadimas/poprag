import { Chat } from '@/components/chat'
import { Button } from '@/components/ui/button'
import { useTRPC } from '@/integrations/trpc/react'
import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'

export const Route = createFileRoute('/_app/agents/$agentId/chat')({
  component: ChatPage,
  validateSearch: () => ({}),
})

function ChatPage() {
  const { agentId } = Route.useParams()
  const trpc = useTRPC()
  const { data: agent } = useSuspenseQuery(
    trpc.agent.get.queryOptions({ id: agentId })
  )
  
  if (!agent) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold">Agent not found</h1>
        <p className="text-muted-foreground mt-2">The agent you attempted to chat with does not exist or you do not have access.</p>
        <div className="mt-4">
          <Link to="/agents">
            <Button variant="outline">Back to Agents</Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className=" h-full flex flex-col">
      {/* Header */}
      <div className="mb-6 shrink-0">
        <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
          <Link to="/agents" className="hover:text-foreground">
            Agents
          </Link>
          <span>/</span>
          <Link to="/agents/$agentId" params={{ agentId }} search={{ tab: "overview" }} className="hover:text-foreground">
            {agent.name}
          </Link>
          <span>/</span>
          <span>Chat</span>
        </div>
        <div className="flex justify-between items-start">
          <div>
            <h1 className="text-3xl font-bold">Chat with {agent.name}</h1>
            <p className="text-muted-foreground mt-1">Ask questions about your knowledge base</p>
          </div>
          <Button asChild variant="outline">
            <Link to="/agents/$agentId" params={{ agentId }} search={{ tab: "overview" }}>Back to Agent</Link>
          </Button>
        </div>
      </div>

      {/* Chat Container */}
      <div className="bg-card border rounded-lg overflow-hidden flex-1">
        <Chat agentId={agentId} />
      </div>
    </div>
  )
}
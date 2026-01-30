# Missing Features, Improvements & Enhancements

> A comprehensive list of potential features, improvements, and enhancements for PopRAG based on codebase analysis.

---

## Table of Contents

- [High Priority](#high-priority)
- [RAG & Knowledge Management](#rag--knowledge-management)
- [Agent Management](#agent-management)
- [Chat & Conversation](#chat--conversation)
- [Authentication & Authorization](#authentication--authorization)
- [Observability & Analytics](#observability--analytics)
- [UI/UX Improvements](#uiux-improvements)
- [Performance & Scalability](#performance--scalability)
- [Developer Experience](#developer-experience)
- [Security & Compliance](#security--compliance)
- [Integrations](#integrations)

---

## High Priority

### 1. Multi-Tenant Workspace Support
**Status:** Not implemented  
**Description:** Currently all agents are visible to all users. Need proper workspace/organization isolation.
- [ ] Create `workspace` table with membership
- [ ] Add `workspaceId` to agents, knowledge sources, etc.
- [ ] Implement workspace-scoped queries throughout
- [ ] Add workspace switcher in UI

### 2. Role-Based Access Control (RBAC)
**Status:** Partially implemented (schema exists, not enforced)  
**Description:** The `user.isAdmin` field exists but RBAC is not enforced.
- [ ] Define roles: Owner, Admin, Editor, Viewer, Analyst
- [ ] Implement permission checks in tRPC procedures
- [ ] Add role assignment UI
- [ ] Workspace-level vs agent-level permissions

### 3. API Key Authentication
**Status:** Not implemented  
**Description:** External API access requires API keys for integrating agents into third-party apps.
- [ ] Create `apiKey` table with scopes
- [ ] Implement API key generation/revocation
- [ ] Add API key middleware for `/api/chat` routes
- [ ] Rate limiting per API key

---

## RAG & Knowledge Management

### 4. URL/Website Ingestion
**Status:** Schema supports it, not implemented  
**Description:** `knowledgeSource.type` has `url` enum value but no implementation.
- [ ] Implement URL fetching (with rate limiting, robots.txt respect)
- [ ] HTML-to-markdown conversion
- [ ] Scheduled re-crawling for live content
- [ ] Sitemap parsing for bulk URL imports

### 5. Manual Knowledge Entry
**Status:** Schema supports it, not implemented  
**Description:** `knowledgeSource.type` has `manual` enum value.
- [ ] Rich text editor for manual entries
- [ ] Support for Q&A pairs
- [ ] FAQ-style knowledge input
- [ ] Bulk import from CSV/JSON

### 6. Dataset Integration
**Status:** Schema supports it, not implemented  
**Description:** `knowledgeSource.type` has `dataset` enum value.
- [ ] Support for structured datasets (CSV, JSON)
- [ ] Table-aware chunking
- [ ] Schema extraction and metadata
- [ ] SQL-like querying over structured data

### 7. Knowledge Source Preview
**Status:** Partially implemented  
**Description:** Can view chunks but no full document preview.
- [ ] PDF viewer integration
- [ ] Original file preview with highlighting
- [ ] Chunk boundary visualization
- [ ] Side-by-side original vs chunks view

### 8. Contextual Chunk Enhancement
**Status:** Documented but not implemented  
**Description:** Prepend LLM-generated context to each chunk for better retrieval.
- [ ] Add contextual enhancement during ingestion
- [ ] Store enhanced chunks separately
- [ ] A/B testing enhanced vs original chunks
- [ ] Cost/benefit analysis tooling

### 9. Semantic Caching
**Status:** Not implemented  
**Description:** Cache similar query results to reduce latency and costs.
- [ ] Implement query embedding cache
- [ ] Similarity-based cache lookup
- [ ] TTL-based cache invalidation
- [ ] Cache hit/miss analytics

### 10. Knowledge Source Versioning
**Status:** Not implemented  
**Description:** Track changes to knowledge sources over time.
- [ ] Store version history per source
- [ ] Diff viewer for content changes
- [ ] Rollback to previous versions
- [ ] Automatic re-indexing on version change

### 11. Knowledge Source Tags/Categories
**Status:** Not implemented  
**Description:** Organize and filter knowledge sources.
- [ ] Add tags/categories to knowledge sources
- [ ] Filter retrieval by tags
- [ ] Tag-based analytics
- [ ] Bulk tagging operations

### 12. Duplicate Detection
**Status:** Not implemented  
**Description:** Prevent duplicate content from being indexed.
- [ ] Checksum-based duplicate detection
- [ ] Semantic similarity duplicate detection
- [ ] Merge/dedupe workflow

---

## Agent Management

### 13. Agent Cloning/Templates
**Status:** Not implemented  
**Description:** Create agents from templates or clone existing agents.
- [ ] Clone agent with all settings
- [ ] Agent templates library
- [ ] Template marketplace (public/private)
- [ ] Import/export agent configurations

### 14. Agent Versioning
**Status:** Prompts versioned, agent config not  
**Description:** Full agent configuration versioning for reproducibility.
- [ ] Snapshot entire agent config
- [ ] Compare agent versions
- [ ] Rollback agent to previous version
- [ ] Version-based deployments

### 15. Agent Deployment Environments
**Status:** Not implemented  
**Description:** Separate dev/staging/prod environments per agent.
- [ ] Environment-specific configurations
- [ ] Promotion workflow (dev → staging → prod)
- [ ] Environment-specific API endpoints
- [ ] A/B testing between environments

### 16. Agent Sharing & Publishing
**Status:** Schema has visibility, UI not implemented  
**Description:** Share agents across workspaces or publicly.
- [ ] Public agent directory
- [ ] Shareable agent links
- [ ] Embedding agents in external sites
- [ ] Agent marketplace

### 17. Agent Health Checks
**Status:** Not implemented  
**Description:** Automated health monitoring for agents.
- [ ] Periodic test queries
- [ ] Response quality scoring
- [ ] Alerting on degradation
- [ ] Dashboard health indicators

### 18. Agent Scheduling
**Status:** Not implemented  
**Description:** Schedule agent availability windows.
- [ ] Business hours configuration
- [ ] Scheduled maintenance windows
- [ ] Holiday schedules
- [ ] Fallback messages during downtime

---

## Chat & Conversation

### 19. Conversation Persistence
**Status:** Transcripts stored, not exposed  
**Description:** Allow users to continue previous conversations.
- [ ] List previous conversations
- [ ] Continue conversation from history
- [ ] Conversation search
- [ ] Export conversation history

### 20. Conversation Branching
**Status:** Not implemented  
**Description:** Fork conversations at any point.
- [ ] Branch from any message
- [ ] Compare branches
- [ ] Merge branches
- [ ] Branch management UI

### 21. Suggested Follow-ups
**Status:** Not implemented  
**Description:** AI-generated follow-up questions.
- [ ] Generate suggested questions after each response
- [ ] Context-aware suggestions
- [ ] Clickable suggestion chips
- [ ] Learn from user selections

### 22. Message Editing
**Status:** Not implemented  
**Description:** Edit and regenerate from previous messages.
- [ ] Edit user messages
- [ ] Regenerate assistant responses
- [ ] Track edit history
- [ ] A/B compare regenerated responses

### 23. Feedback Collection
**Status:** Not implemented  
**Description:** Collect user feedback on responses.
- [ ] Thumbs up/down per message
- [ ] Detailed feedback form
- [ ] Feedback analytics dashboard
- [ ] Use feedback for fine-tuning

### 24. Citation Linking
**Status:** Partially implemented (RAG debug panel)  
**Description:** Clickable citations in responses.
- [ ] Inline citation markers
- [ ] Click to view source
- [ ] Highlight relevant passage in source
- [ ] Citation confidence indicators

### 25. Multimodal Support Expansion
**Status:** Image input implemented  
**Description:** Expand to more modalities.
- [ ] Audio input (voice messages)
- [ ] PDF attachment in chat
- [ ] Audio output (TTS)
- [ ] Video analysis

### 26. Streaming Improvements
**Status:** Basic streaming implemented  
**Description:** Enhanced streaming features.
- [ ] Streaming citations as they're identified
- [ ] Streaming tool call progress
- [ ] Cancelable streaming
- [ ] Stream reconnection on disconnect

### 27. Chat Widget / Embed
**Status:** Not implemented  
**Description:** Embeddable chat widget for external sites.
- [ ] Configurable chat widget
- [ ] Embed code generator
- [ ] Widget customization (colors, position)
- [ ] Cross-origin support

---

## Authentication & Authorization

### 28. OAuth Provider Expansion
**Status:** Better-auth supports many, few configured  
**Description:** Add more OAuth providers.
- [ ] GitHub OAuth
- [ ] Microsoft/Azure AD
- [ ] Slack OAuth
- [ ] Custom SAML/OIDC

### 29. SSO Support
**Status:** Not implemented  
**Description:** Enterprise SSO integration.
- [ ] SAML 2.0 support
- [ ] OIDC support
- [ ] SCIM provisioning
- [ ] Just-in-time provisioning

### 30. Session Management
**Status:** Basic session support  
**Description:** Enhanced session controls.
- [ ] View active sessions
- [ ] Remote session revocation
- [ ] Session timeout configuration
- [ ] Concurrent session limits

### 31. Password Policies
**Status:** Not implemented  
**Description:** Enterprise password requirements.
- [ ] Password complexity rules
- [ ] Password expiration
- [ ] Password history
- [ ] Account lockout policies

---

## Observability & Analytics

### 32. Real-Time Analytics Dashboard
**Status:** Basic metrics exist  
**Description:** Comprehensive analytics dashboard.
- [ ] Real-time request/response metrics
- [ ] Token usage graphs
- [ ] Cost tracking over time
- [ ] Error rate visualization
- [ ] Latency percentiles (p50, p95, p99)

### 33. Cost Management
**Status:** Partially implemented  
**Description:** Track and manage AI costs.
- [x] Per-agent cost tracking (stored in `runMetric.costMicrocents`)
- [x] Cost calculation based on model capabilities from models.dev
- [x] Cost display in agent metrics (per run, per conversation, per user)
- [x] Cost columns in model alias table with sorting
- [ ] Budget alerts and limits
- [ ] Cost forecasting
- [ ] Cost optimization recommendations
- [ ] Cost time-series visualization

### 34. Usage Quotas
**Status:** Not implemented  
**Description:** Rate limiting and usage quotas.
- [ ] Per-user/workspace quotas
- [ ] Per-agent quotas
- [ ] Token-based limits
- [ ] Request count limits
- [ ] Overage handling (throttle vs block)

### 35. Retrieval Quality Analytics
**Status:** Partial (RAG debug in transcripts)  
**Description:** Measure and improve RAG performance.
- [ ] Retrieval precision/recall tracking
- [ ] Query success rate
- [ ] Empty result analysis
- [ ] Chunk utilization heatmaps

### 36. User Behavior Analytics
**Status:** Not implemented  
**Description:** Understand how users interact with agents.
- [ ] Session duration
- [ ] Messages per session
- [ ] Common query patterns
- [ ] User satisfaction scores

### 37. Alerting System
**Status:** Not implemented  
**Description:** Proactive alerting on issues.
- [ ] Error spike alerts
- [ ] Latency threshold alerts
- [ ] Budget threshold alerts
- [ ] Integration with PagerDuty/Slack/etc.

### 38. Log Export
**Status:** Not implemented  
**Description:** Export logs for external analysis.
- [ ] Export transcripts to CSV/JSON
- [ ] Integration with log aggregators
- [ ] Webhook for real-time log streaming
- [ ] GDPR-compliant log management

---

## UI/UX Improvements

### 39. Dark/Light Theme Toggle
**Status:** Partial (theme exists, no toggle)  
**Description:** User-controllable theme switching.
- [ ] Theme toggle in settings
- [ ] System preference detection
- [ ] Per-user theme persistence
- [ ] Custom theme support

### 40. Keyboard Shortcuts
**Status:** Not implemented  
**Description:** Power user keyboard navigation.
- [ ] Global shortcuts (new chat, search, etc.)
- [ ] Chat shortcuts (send, clear, etc.)
- [ ] Shortcut reference dialog
- [ ] Customizable shortcuts

### 41. Mobile Responsiveness
**Status:** Partial  
**Description:** Full mobile optimization.
- [ ] Responsive chat interface
- [ ] Mobile-friendly navigation
- [ ] Touch-optimized controls
- [ ] PWA support

### 42. Onboarding Flow
**Status:** Not implemented  
**Description:** Guide new users through setup.
- [ ] First-run wizard
- [ ] Feature tours
- [ ] Sample agents/knowledge
- [ ] Progress indicators

### 43. Bulk Operations
**Status:** Not implemented  
**Description:** Operate on multiple items at once.
- [ ] Bulk delete knowledge sources
- [ ] Bulk agent operations
- [ ] Bulk user management
- [ ] Import/export configurations

### 44. Search & Filtering
**Status:** Minimal  
**Description:** Comprehensive search across the platform.
- [ ] Global search
- [ ] Agent search with filters
- [ ] Knowledge source search
- [ ] Transcript search
- [ ] Saved searches

### 45. Localization (i18n)
**Status:** Not implemented  
**Description:** Multi-language support.
- [ ] UI localization
- [ ] Agent prompt localization
- [ ] RTL language support
- [ ] Date/number formatting

---

## Performance & Scalability

### 46. Query Caching
**Status:** Not implemented  
**Description:** Cache frequent queries and embeddings.
- [ ] Cloudflare KV for embedding cache
- [ ] Query result caching
- [ ] Cache invalidation strategies
- [ ] Cache analytics

### 47. Connection Pooling
**Status:** D1 handles internally  
**Description:** Optimize database connections.
- [ ] Connection pool monitoring
- [ ] Query optimization
- [ ] Slow query logging
- [ ] Index optimization recommendations

### 48. Background Job Queue
**Status:** Not implemented  
**Description:** Robust async job processing.
- [ ] Cloudflare Queues integration
- [ ] Job retry with backoff
- [ ] Job prioritization
- [ ] Dead letter queue
- [ ] Job status dashboard

### 49. CDN Optimization
**Status:** Partial (Cloudflare)  
**Description:** Optimize static asset delivery.
- [ ] Asset optimization pipeline
- [ ] Edge caching rules
- [ ] Image optimization
- [ ] Font optimization

### 50. Database Sharding Strategy
**Status:** Not needed yet  
**Description:** Prepare for scale.
- [ ] Document sharding approach
- [ ] Per-workspace D1 instances
- [ ] Cross-shard queries
- [ ] Data migration tooling

---

## Developer Experience

### 51. API Documentation
**Status:** Not implemented  
**Description:** Auto-generated API docs.
- [ ] OpenAPI/Swagger spec generation
- [ ] Interactive API explorer
- [ ] Code examples per endpoint
- [ ] SDKs for popular languages

### 52. Webhook Support
**Status:** Not implemented  
**Description:** Event webhooks for integrations.
- [ ] Webhook registration
- [ ] Event types (message, error, etc.)
- [ ] Webhook signature verification
- [ ] Webhook delivery logs

### 53. CLI Tool
**Status:** Not implemented  
**Description:** Command-line interface for PopRAG.
- [ ] Agent management CLI
- [ ] Knowledge upload CLI
- [ ] Bulk operations
- [ ] CI/CD integration

### 54. Testing Utilities
**Status:** Minimal  
**Description:** Built-in testing tools.
- [ ] Agent testing sandbox
- [ ] Batch evaluation runner
- [ ] Regression testing
- [ ] Golden response comparisons

### 55. Plugin/Extension System
**Status:** Not implemented  
**Description:** Extensibility framework.
- [ ] Custom tool definitions
- [ ] Custom parsers for file types
- [ ] Custom embedding providers
- [ ] Plugin marketplace

---

## Security & Compliance

### 56. PII Detection & Redaction
**Status:** Mentioned in plan, not implemented  
**Description:** Protect sensitive data.
- [ ] PII detection in uploads
- [ ] Automatic redaction
- [ ] PII flagging workflow
- [ ] Compliance reporting

### 57. Data Retention Policies
**Status:** Not implemented  
**Description:** Configurable data lifecycle.
- [ ] Retention period configuration
- [ ] Automatic data deletion
- [ ] Retention policy per data type
- [ ] Deletion audit logs

### 58. Audit Log Enhancement
**Status:** Basic audit log exists  
**Description:** Comprehensive audit trail.
- [ ] All admin actions logged
- [ ] API access logging
- [ ] User activity logging
- [ ] Audit log export
- [ ] Tamper-evident audit trail

### 59. Encryption at Rest
**Status:** Cloudflare handles, not verified  
**Description:** Verify and document encryption.
- [ ] Document encryption practices
- [ ] Customer-managed keys option
- [ ] Key rotation procedures
- [ ] Encryption compliance certification

### 60. Security Headers
**Status:** Partial  
**Description:** HTTP security headers.
- [ ] CSP headers
- [ ] HSTS
- [ ] X-Frame-Options
- [ ] Security header audit

### 61. Vulnerability Scanning
**Status:** Not implemented  
**Description:** Automated security scanning.
- [ ] Dependency scanning
- [ ] SAST integration
- [ ] Regular penetration testing
- [ ] Security advisory monitoring

---

## Integrations

### 62. Slack Integration
**Status:** Not implemented  
**Description:** Chat with agents in Slack.
- [ ] Slack bot setup
- [ ] Direct message support
- [ ] Channel integration
- [ ] Slash commands

### 63. Discord Integration
**Status:** Not implemented  
**Description:** Discord bot for agents.
- [ ] Discord bot setup
- [ ] Server integration
- [ ] Slash commands

### 64. Microsoft Teams Integration
**Status:** Not implemented  
**Description:** Teams bot/tab integration.
- [ ] Teams bot
- [ ] Teams tab
- [ ] Adaptive cards

### 65. Zapier/Make Integration
**Status:** Not implemented  
**Description:** Automation platform integration.
- [ ] Zapier triggers
- [ ] Zapier actions
- [ ] Make.com integration

### 66. Custom Tool Framework
**Status:** getInformation tool exists  
**Description:** User-defined tools for agents.
- [ ] Tool definition UI
- [ ] HTTP API tools
- [ ] Database query tools
- [ ] File system tools
- [ ] Tool execution sandboxing

### 67. LangChain/LlamaIndex Compatibility
**Status:** Not implemented  
**Description:** Integration with popular frameworks.
- [ ] Export to LangChain format
- [ ] LlamaIndex data connector
- [ ] Standard RAG interface

---

## Evaluation & Testing

### 68. Evaluation Datasets
**Status:** Schema exists (`evalDataset`), not implemented  
**Description:** Create and manage test datasets.
- [ ] Dataset creation UI
- [ ] Question-answer pairs
- [ ] Expected retrieval targets
- [ ] Dataset versioning

### 69. Automated Evaluation Runs
**Status:** Not implemented  
**Description:** Run evaluations against agents.
- [ ] Scheduled evaluation runs
- [ ] Comparison across agent versions
- [ ] Metric tracking (accuracy, relevance, etc.)
- [ ] Regression alerts

### 70. A/B Testing Framework
**Status:** Not implemented  
**Description:** Compare agent configurations.
- [ ] Traffic splitting
- [ ] Statistical significance calculation
- [ ] Automatic winner selection
- [ ] A/B test history

### 71. Human Evaluation Queue
**Status:** Not implemented  
**Description:** Queue responses for human review.
- [ ] Review queue UI
- [ ] Rating system
- [ ] Feedback aggregation
- [ ] Quality trend tracking

---

## Infrastructure

### 72. Multi-Region Deployment
**Status:** Not implemented  
**Description:** Deploy across regions.
- [ ] Regional Vectorize indexes
- [ ] D1 replication strategy
- [ ] Geo-routing
- [ ] Latency-based routing

### 73. Disaster Recovery
**Status:** Not documented  
**Description:** Backup and recovery procedures.
- [ ] Automated D1 backups
- [ ] R2 backup strategy
- [ ] Vectorize backup
- [ ] Recovery testing
- [ ] RTO/RPO documentation

### 74. Blue-Green Deployments
**Status:** Not implemented  
**Description:** Zero-downtime deployments.
- [ ] Deployment strategy documentation
- [ ] Rollback procedures
- [ ] Health check gates
- [ ] Traffic shifting

---

## Documentation

### 75. User Documentation
**Status:** Minimal  
**Description:** End-user guides.
- [ ] Getting started guide
- [ ] Agent creation tutorial
- [ ] Knowledge management guide
- [ ] Best practices

### 76. Admin Documentation
**Status:** Minimal  
**Description:** Administrator guides.
- [ ] Deployment guide
- [ ] Configuration reference
- [ ] Troubleshooting guide
- [ ] Performance tuning

### 77. API Reference
**Status:** Not implemented  
**Description:** Complete API documentation.
- [ ] tRPC procedure reference
- [ ] Chat API reference
- [ ] Webhook reference
- [ ] Error codes

### 78. Architecture Documentation
**Status:** AGENTS.md exists  
**Description:** Technical architecture docs.
- [ ] System architecture diagram
- [ ] Data flow diagrams
- [ ] Component interactions
- [ ] Decision records (ADRs)

---

## Summary

| Category | Total Items | Status |
|----------|-------------|--------|
| High Priority | 3 | 🔴 Critical |
| RAG & Knowledge | 12 | 🟡 Partial |
| Agent Management | 6 | 🟡 Partial |
| Chat & Conversation | 9 | 🟡 Partial |
| Auth & Authorization | 4 | 🟡 Partial |
| Observability | 7 | 🟢 Good |
| UI/UX | 7 | 🟡 Partial |
| Performance | 5 | 🟢 Adequate |
| Developer Experience | 5 | 🔴 Needs Work |
| Security & Compliance | 6 | 🟡 Partial |
| Integrations | 6 | 🔴 Not Started |
| Evaluation & Testing | 4 | 🔴 Not Started |
| Infrastructure | 3 | 🟡 Partial |
| Documentation | 4 | 🔴 Needs Work |

**Total: 78 potential improvements identified**

---

## Contributing

When implementing any of these features:
1. Create an issue in GitHub
2. Reference this document
3. Update status as work progresses
4. Add/update relevant tests
5. Update documentation

---

*Last updated: January 2026*

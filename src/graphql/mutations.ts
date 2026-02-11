export const ACTIVITY_MUTATION = `
  mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
    agentActivityCreate(input: $input) {
      success
      agentActivity { id }
    }
  }
`;

export const SESSION_UPDATE_MUTATION = `
  mutation AgentSessionUpdate($id: String!, $input: AgentSessionUpdateInput!) {
    agentSessionUpdate(id: $id, input: $input) { success }
  }
`;

export const ISSUE_UPDATE_MUTATION = `
  mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) {
      success
      issue { id identifier }
    }
  }
`;

export const ISSUE_CREATE_MUTATION = `
  mutation IssueCreate($input: IssueCreateInput!) {
    issueCreate(input: $input) {
      success
      issue {
        id
        identifier
        title
        url
        state { id name type }
        team { id key }
      }
    }
  }
`;

export const ISSUE_RELATION_CREATE_MUTATION = `
  mutation IssueRelationCreate($input: IssueRelationCreateInput!) {
    issueRelationCreate(input: $input) {
      success
      issueRelation {
        id
        type
        issue { id identifier }
        relatedIssue { id identifier }
      }
    }
  }
`;

export const COMMENT_CREATE_MUTATION = `
  mutation CommentCreate($input: CommentCreateInput!) {
    commentCreate(input: $input) {
      success
      comment { id body }
    }
  }
`;

export const AGENT_SESSION_CREATE_ON_ISSUE_MUTATION = `
  mutation AgentSessionCreateOnIssue($issueId: String!) {
    agentSessionCreateOnIssue(issueId: $issueId) {
      success
      agentSession { id }
    }
  }
`;

export const AGENT_SESSION_CREATE_ON_COMMENT_MUTATION = `
  mutation AgentSessionCreateOnComment($commentId: String!) {
    agentSessionCreateOnComment(commentId: $commentId) {
      success
      agentSession { id }
    }
  }
`;

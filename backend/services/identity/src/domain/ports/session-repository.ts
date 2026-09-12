import type { Session } from '../session';

export interface SessionRepository {
  create(session: Session): Promise<void>;
}

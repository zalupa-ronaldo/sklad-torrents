/**
 * The move-to-SSD addon removes the source folder only after the copy has been
 * checked and the user confirms. Both flags are required. This screen does not
 * delete anything by itself.
 */
export function canDeleteSource(state: { copyVerified: boolean; userConfirmed: boolean }): boolean {
  return state.copyVerified === true && state.userConfirmed === true;
}

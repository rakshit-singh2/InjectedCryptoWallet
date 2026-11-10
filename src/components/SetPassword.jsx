import { useState } from 'react';
import { Button, Input, Typography } from 'antd';

const { Text } = Typography;

export function validatePassword(password) {
  if (password.length < 8) return 'Password must be at least 8 characters long.';
  if (!/[A-Z]/.test(password)) return 'Password must contain at least one uppercase letter.';
  if (!/[a-z]/.test(password)) return 'Password must contain at least one lowercase letter.';
  if (!/\d/.test(password)) return 'Password must contain at least one number.';
  if (!/[^A-Za-z0-9]/.test(password)) return 'Password must contain at least one special character.';
  return '';
}

/** New-password form. The password is handed to `onSubmit` and is not stored by the popup. */
function SetPassword({ onSubmit, submitLabel = 'Set Password', busy = false }) {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');

  const submit = async (event) => {
    event.preventDefault();
    const problem = validatePassword(password) || (password !== confirmPassword ? 'Passwords do not match.' : '');
    if (problem) {
      setError(problem);
      return;
    }
    setError('');
    await onSubmit(password);
  };

  return (
    <form onSubmit={submit} style={{ width: '100%' }}>
      <Input.Password
        data-testid="new-password-input"
        aria-label="New password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="New password"
        autoComplete="new-password"
        style={{ marginBottom: 12 }}
      />
      <Input.Password
        data-testid="confirm-password-input"
        aria-label="Confirm password"
        value={confirmPassword}
        onChange={(e) => setConfirmPassword(e.target.value)}
        placeholder="Confirm password"
        autoComplete="new-password"
        style={{ marginBottom: 12 }}
      />
      {error && <Text type="danger" role="alert">{error}</Text>}
      <Button data-testid="set-password-submit-button" className="frontPageButton" type="primary" htmlType="submit" block loading={busy}>
        {submitLabel}
      </Button>
    </form>
  );
}

export default SetPassword;

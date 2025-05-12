import React from "react";

function Footer() {
  return (
    <div style={styles.footer}>
      <p style={styles.text}>
        Built with ❤️ for You. Reach out to me on{" "}
        <a
          href="https://github.com/teekaysharma"
          target="_blank"
          rel="noopener noreferrer"
          style={styles.link}
        >
          GitHub
        </a>
      </p>
    </div>
  );
}

const styles = {
  footer: {
    position: "fixed",
    bottom: 0,
    width: "100%",
    padding: "4px 12px",
    fontSize: "0.75rem",
    textAlign: "center",
    backgroundColor: "#f9f9f9",
    color: "#666",
    borderTop: "1px solid #ddd",
    zIndex: 100,
  },
  text: {
    margin: 0,
  },
  link: {
    color: "#1E90FF",
    textDecoration: "none",
  },
};

export default Footer;

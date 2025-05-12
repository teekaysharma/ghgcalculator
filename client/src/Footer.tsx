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
    left: 0,
    right: 0,
    backgroundColor: "#333",
    color: "#fff",
    textAlign: "center",
    padding: "10px",
    fontSize: "14px",
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
